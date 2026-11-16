import { z } from "zod";
import type { SaveStorageDriver } from "../persistence/storage-driver";
import type { MatchState } from "../core/match/types";
import type { TelemetryFlow as FlowRun } from "./types";
import { gunStatistics, summarizeTelemetry } from "./summary";
import { ACHIEVEMENT_CATALOG_BATCH, ACHIEVEMENT_EVENT_MAX_BYTES, ACHIEVEMENT_UNLOCK_BATCH, AchievementTelemetryKey,
  LoadedAchievementsData, UnlockedAchievementsData, achievementCatalogHash, catalogItems, telemetryByteLength, unlockItems } from "./achievement-protocol";
import type { AchievementCatalogItem, AchievementTelemetryEvent, AchievementUnlockItem, BaseTelemetryEvent, ClientMetadata, EncounterTelemetry, MatchObservation, MatchStatistics, TelemetryEvent } from "./types";

const MAX_PENDING = 1000, MAX_AGE = 7 * 86_400_000;
const StoredEvent = z.object({ schema_version: z.literal(1), event_id: z.uuid(), installation_id: z.uuid(), session_id: z.uuid(),
  occurred_at: z.string(), event_type: z.enum(["app_started", "match_finished"]) }).passthrough();
const StoredAchievementEvent = z.discriminatedUnion("event_type", [
  StoredEvent.omit({ event_type: true }).extend({ event_type: z.literal("achievements_loaded"), data: LoadedAchievementsData }),
  StoredEvent.omit({ event_type: true }).extend({ event_type: z.literal("achievements_unlocked"), data: UnlockedAchievementsData })
]).refine(event => telemetryByteLength(event) <= ACHIEVEMENT_EVENT_MAX_BYTES, "Achievement event too large");
const AchievementPending = z.array(z.object({ queued_at: z.number(), event: StoredAchievementEvent })).max(MAX_PENDING);
const MatchMetadata = z.object({ source_id: z.string(), match_id: z.uuid(), event_id: z.uuid(), started_at: z.string().nullable(),
  initial: z.object({ player: z.number().int().nonnegative(), opponent: z.number().int().nonnegative() }).nullable(),
  elapsed_ms: z.number().nonnegative(), restored: z.boolean(), debug_used: z.boolean(), finished: z.boolean(),
  ended_at: z.string().optional(), configuration_hash: z.string().optional() });
const State = z.object({ version: z.literal(1), installation_id: z.uuid(), enabled: z.boolean(),
  pending: z.array(z.object({ queued_at: z.number(), event: StoredEvent })).max(MAX_PENDING),
  matches: z.array(MatchMetadata).max(MAX_PENDING),
  // Older clients strip these optional fields while retaining their original outbox and identity.
  achievement_pending: AchievementPending.catch([]).default([]),
  achievement_catalogs: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512).catch([]).default([]),
  achievement_keys: z.array(AchievementTelemetryKey).max(4096).catch([]).default([]),
  achievement_had_catalog: z.boolean().catch(false).default(false),
  achievement_capability_endpoint: z.string().optional().catch(undefined)
});
type Pending<Event> = { queued_at: number; event: Event };
type StateValue = Omit<z.infer<typeof State>, "pending" | "achievement_pending"> & {
  pending: Pending<BaseTelemetryEvent>[]; achievement_pending: Pending<AchievementTelemetryEvent>[];
};
export interface ClientOptions {
  endpoint: string; environment: TelemetryEvent["environment"]; gameVersion: string; buildId: string; client: ClientMetadata;
  driver: SaveStorageDriver; fetch?: typeof fetch; now?: () => number; clock?: () => number; uuid?: () => string;
  opponent?: (id: string) => MatchStatistics["opponent"];
  getAchievementCatalog?: () => readonly { readonly key: string; readonly definition: { readonly revision: number } }[];
}
export function secureUuid(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function stableUuid(value: string, fallback: () => string): Promise<string> {
  if (!globalThis.crypto.subtle) return fallback();
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An installation-local outbox, independent of exported progress and per-table UI lifetimes. */
export class TelemetryClient implements EncounterTelemetry {
  private state!: StateValue;
  private loaded?: Promise<void>;
  private writing = Promise.resolve();
  private started = false;
  private sessionId: string;
  private startEventId: string;
  private persistent = true;
  private sending?: Promise<void>;
  private resendRequested = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private achievementTimer?: ReturnType<typeof setTimeout>;
  private gzipUnavailable = false;
  private retryCount = 0;
  private request?: AbortController;
  private consentGeneration = 0;
  private visible = true;
  private ticks = new Map<string, number>();
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly uuid: () => string;
  constructor(private readonly options: ClientOptions) {
    const url = new URL(options.endpoint);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) || url.username || url.password || url.hash || url.search)
      throw new Error("Telemetry endpoint must use HTTPS (localhost HTTP is allowed)");
    this.now = options.now ?? Date.now; this.clock = options.clock ?? (() => performance.now()); this.uuid = options.uuid ?? secureUuid;
    this.sessionId = this.uuid(); this.startEventId = this.uuid();
  }
  get enabled(): boolean { return this.state?.enabled ?? true; }
  get pendingCount(): number { return (this.state?.pending.length ?? 0) + (this.state?.achievement_pending.length ?? 0); }
  /** Read the installation preference without starting a game or sending an event. */
  async ready(): Promise<void> { await this.load(); }
  private load(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      // A transient read failure is not evidence that consent or identity is absent.
      const raw = (await this.options.driver.readSnapshot())?.longTerm;
      try {
        this.state = State.parse(raw) as unknown as StateValue;
        const pending = (raw as { achievement_pending?: unknown } | undefined)?.achievement_pending;
        if (pending !== undefined && !AchievementPending.safeParse(pending).success) {
          // A lost optional queue must not leave receipts that acknowledge work never re-enqueued.
          this.state.achievement_catalogs = []; this.state.achievement_keys = [];
        }
      }
      catch { this.state = { version: 1, installation_id: this.uuid(), enabled: true, pending: [], matches: [],
        achievement_pending: [], achievement_catalogs: [], achievement_keys: [], achievement_had_catalog: false }; }
      this.prune();
    })().catch(error => { this.loaded = undefined; throw error; });
    return this.loaded;
  }
  private prune(): void {
    this.state.pending = this.state.pending.filter(item => item.queued_at >= this.now() - MAX_AGE).slice(-MAX_PENDING);
    this.state.achievement_pending = this.state.achievement_pending.filter(item => item.queued_at >= this.now() - MAX_AGE);
    if (this.state.matches.length > MAX_PENDING) this.state.matches = this.state.matches.slice(-MAX_PENDING);
  }
  private async persist(): Promise<void> {
    this.prune();
    try { await this.options.driver.writeSnapshot({ longTerm: structuredClone(this.state), runtime: null }); this.persistent = true; }
    catch (error) { this.persistent = false; throw error; }
  }
  private update(operation: () => void | false | Promise<void | false>): Promise<void> {
    const result = this.writing.catch(() => undefined).then(async () => {
      await this.load();
      const previous = structuredClone(this.state);
      const previousTicks = new Map(this.ticks), previousVisible = this.visible;
      try { if (await operation() !== false) await this.persist(); }
      catch (error) { this.state = previous; this.ticks = previousTicks; this.visible = previousVisible; throw error; }
    });
    this.writing = result.catch(() => undefined);
    return result;
  }
  private envelope(eventId: string) {
    return { schema_version: 1 as const, event_id: eventId, installation_id: this.state.installation_id, session_id: this.sessionId,
      occurred_at: new Date(this.now()).toISOString(), game_version: this.options.gameVersion, build_id: this.options.buildId,
      environment: this.options.environment, client: this.options.client };
  }
  private append(event: BaseTelemetryEvent): void {
    if (!this.state.pending.some(item => item.event.event_id === event.event_id)) this.state.pending.push({ queued_at: this.now(), event });
  }
  private appendAchievements(events: readonly AchievementTelemetryEvent[]): void {
    this.prune();
    if (this.state.achievement_pending.length + events.length > MAX_PENDING) throw new Error("Achievement telemetry outbox capacity exceeded");
    this.state.achievement_pending.push(...events.map(event => ({ queued_at: this.now(), event })));
  }
  async start(): Promise<void> {
    if (this.started) return;
    await this.update(() => {
      if (this.state.enabled) this.append({ ...this.envelope(this.startEventId), event_type: "app_started", data: { storage: this.persistent ? "persistent" : "ephemeral" } });
    });
    this.started = true; this.kick();
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.consentGeneration++; this.request?.abort(); clearTimeout(this.retryTimer); this.retryTimer = undefined;
    clearTimeout(this.achievementTimer); this.achievementTimer = undefined;
    await this.update(() => { this.state.enabled = enabled; if (!enabled) { this.state.pending = []; this.state.matches = [];
      this.state.achievement_pending = []; this.state.achievement_catalogs = []; this.state.achievement_keys = []; this.state.achievement_had_catalog = false; this.ticks.clear(); }
      else this.append({ ...this.envelope(this.startEventId), event_type: "app_started", data: { storage: this.persistent ? "persistent" : "ephemeral" } }); });
    if (enabled) {
      if (this.options.getAchievementCatalog) await this.recordAchievementCatalog(this.options.getAchievementCatalog());
      this.kick();
    }
  }

  /** Only identifiers/revisions are captured. Speculative content preparation must not call this. */
  async recordAchievementCatalog(entries: readonly { readonly key: string; readonly definition: { readonly revision: number } }[]): Promise<void> {
    const items = catalogItems(entries);
    let queued = false;
    await this.update(async () => {
      if (!this.enabled || !items.length && !this.state.achievement_had_catalog) return false;
      const hash = await achievementCatalogHash(items);
      if (this.state.achievement_catalogs.includes(hash)) return false;
      const events: AchievementTelemetryEvent[] = [];
      let index = 0;
      do {
        const event = { ...this.envelope(this.uuid()), event_type: "achievements_loaded" as const,
          data: { catalog_hash: hash, part: events.length, parts: Math.max(1, items.length), items: [] as AchievementCatalogItem[] } };
        while (index < items.length && event.data.items.length < ACHIEVEMENT_CATALOG_BATCH) {
          event.data.items.push(items[index]!);
          if (telemetryByteLength(event) > ACHIEVEMENT_EVENT_MAX_BYTES) { event.data.items.pop(); break; }
          index++;
        }
        if (index < items.length && !event.data.items.length) throw new Error("Achievement catalog item exceeds telemetry budget");
        events.push(event);
      } while (index < items.length);
      for (const event of events) {
        if (event.event_type === "achievements_loaded") event.data.parts = events.length;
      }
      this.appendAchievements(events);
      this.state.achievement_catalogs = [...this.state.achievement_catalogs, hash].slice(-512);
      this.state.achievement_had_catalog ||= items.length > 0;
      queued = true;
    });
    if (queued) this.scheduleAchievements();
  }

  /** Callers supply newly committed completions, never restored historical records. */
  async recordAchievementUnlocks(entries: readonly { readonly key: string; readonly completion: { readonly revision: number; readonly at: string }; readonly allowDebug: boolean }[]): Promise<void> {
    const items = unlockItems(entries);
    let queued = false;
    await this.update(() => {
      if (!this.enabled) return false;
      const known = new Set(this.state.achievement_keys);
      const fresh = items.filter(item => { if (known.has(item[0])) return false; known.add(item[0]); return true; });
      if (!fresh.length) return false;
      let index = 0;
      const events: AchievementTelemetryEvent[] = [];
      while (index < fresh.length) {
        const event = { ...this.envelope(this.uuid()), event_type: "achievements_unlocked" as const, data: { items: [] as AchievementUnlockItem[] } };
        while (index < fresh.length && event.data.items.length < ACHIEVEMENT_UNLOCK_BATCH) {
          event.data.items.push(fresh[index]!);
          if (telemetryByteLength(event) > ACHIEVEMENT_EVENT_MAX_BYTES) { event.data.items.pop(); break; }
          index++;
        }
        if (!event.data.items.length) throw new Error("Achievement completion exceeds telemetry budget");
        events.push(event);
      }
      this.appendAchievements(events);
      this.state.achievement_keys = [...known].slice(-4096);
      queued = true;
    });
    if (queued) this.scheduleAchievements();
  }

  private scheduleAchievements(): void {
    if (this.retryTimer) return;
    clearTimeout(this.achievementTimer);
    this.achievementTimer = setTimeout(() => { this.achievementTimer = undefined; this.kick(); }, 500);
    (this.achievementTimer as unknown as { unref?: () => void }).unref?.();
  }
  private tick(id: string): void {
    const meta = this.state.matches.find(item => item.source_id === id), previous = this.ticks.get(id), time = this.clock();
    if (meta && previous !== undefined && this.visible) meta.elapsed_ms += Math.max(0, time - previous);
    if (meta && !meta.finished && this.visible) this.ticks.set(id, time); else this.ticks.delete(id);
  }
  async setVisible(visible: boolean): Promise<void> {
    await this.update(() => {
      for (const id of this.ticks.keys()) this.tick(id);
      this.visible = visible; this.ticks.clear();
      if (visible) for (const meta of this.state.matches) if (!meta.finished) this.ticks.set(meta.source_id, this.clock());
    });
    if (visible) this.kick();
  }
  async observe(match: MatchState, run: FlowRun, observation: MatchObservation = {}): Promise<void> {
    await this.load();
    if (!this.enabled) return;
    const existing = this.state.matches.find(item => item.source_id === match.id);
    if (existing?.finished) return;
    // No disk write for ordinary clicks: the organizer already durably saves game history.
    if (existing && match.status !== "finished" && !observation.restored && (!observation.debugUsed || existing.debug_used)) return;
    await this.update(async () => {
      if (!this.enabled) return;
      let meta = this.state.matches.find(item => item.source_id === match.id);
      if (!meta) {
        const initial = observation.restored || match.status === "finished" ? null : Object.fromEntries((["player", "opponent"] as const).map(actor => {
          const stats = gunStatistics(match, actor, null);
          return [actor, Math.max(0, match.roulette[actor].bullets - (stats.loaded_actual ?? 0) + stats.removed_actual)];
        })) as Record<"player" | "opponent", number>;
        const digest = globalThis.crypto.subtle ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(run.definition)))) : undefined;
        meta = { source_id: match.id,
          match_id: await stableUuid(`match:${this.state.installation_id}:${match.id}`, this.uuid),
          event_id: await stableUuid(`event:${this.state.installation_id}:${match.id}`, this.uuid),
          started_at: initial ? new Date(this.now()).toISOString() : null, initial,
          elapsed_ms: 0, restored: Boolean(observation.restored), debug_used: Boolean(observation.debugUsed), finished: false,
          ...(digest ? { configuration_hash: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("") } : {}) };
        this.state.matches.push(meta); if (this.visible) this.ticks.set(match.id, this.clock());
      }
      if (meta.finished) return;
      meta.restored ||= Boolean(observation.restored); meta.debug_used ||= Boolean(observation.debugUsed);
      if (match.status !== "finished") return;
      this.tick(match.id); meta.finished = true; this.ticks.delete(match.id); meta.ended_at = new Date(this.now()).toISOString();
      const data = summarizeTelemetry(match, run, { matchId: meta.match_id, startedAt: meta.started_at,
        endedAt: meta.ended_at, durationMs: meta.started_at ? Math.min(2_147_483_647, Math.round(meta.elapsed_ms)) : null,
        restored: meta.restored, initial: meta.initial, debugUsed: meta.debug_used,
        opponent: this.options.opponent?.(match.opponentId) ?? { id: match.opponentId, name: match.opponentId }, configurationHash: meta.configuration_hash });
      this.append({ ...this.envelope(meta.event_id), event_type: "match_finished", data });
    });
    this.kick();
  }
  /** Persists local state only. Gameplay never waits for a slow/offline server. */
  flush(): Promise<void> { return this.update(() => { for (const id of this.ticks.keys()) this.tick(id); }); }
  kick(): void {
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    clearTimeout(this.achievementTimer); this.achievementTimer = undefined;
    if (this.sending) { this.resendRequested = true; return; }
    void this.drain().catch(() => undefined);
  }
  drain(): Promise<void> {
    clearTimeout(this.achievementTimer); this.achievementTimer = undefined;
    return this.sending ??= this.sendPending().finally(() => {
      this.sending = undefined;
      if (this.resendRequested) { this.resendRequested = false; this.kick(); }
    });
  }
  private async sendPending(): Promise<void> {
    await this.load(); await this.update(() => undefined);
    while (this.enabled) {
      const generation = this.consentGeneration;
      const capable = this.state.achievement_capability_endpoint === this.options.endpoint;
      const pending = [...this.state.pending, ...(capable ? this.state.achievement_pending : [])]
        .sort((left, right) => left.queued_at - right.queued_at);
      if (!pending.length) return;
      const batch: TelemetryEvent[] = [];
      for (const item of pending.slice(0, 20)) {
        if (new TextEncoder().encode(JSON.stringify({ events: [...batch, item.event] })).byteLength > 60_000) break;
        batch.push(item.event);
      }
      if (!batch.length) { await this.update(() => {
        const id = pending[0]!.event.event_id;
        this.state.pending = this.state.pending.filter(item => item.event.event_id !== id);
        this.state.achievement_pending = this.state.achievement_pending.filter(item => item.event.event_id !== id);
      }); continue; }
      const ids = new Set(batch.map(event => event.event_id));
      const achievementIds = new Set(batch.filter(event => event.event_type === "achievements_loaded" || event.event_type === "achievements_unlocked").map(event => event.event_id));
      const controller = new AbortController(); this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        let body: string | ArrayBuffer = JSON.stringify({ events: batch });
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (capable && !this.gzipUnavailable && typeof CompressionStream === "function" && new TextEncoder().encode(body).byteLength > 1024) {
          try {
            const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
            if (compressed.byteLength + 128 <= new TextEncoder().encode(body).byteLength) { body = compressed; headers["Content-Encoding"] = "gzip"; }
          } catch { /* Older WebViews retain the ordinary JSON transport. */ }
        }
        const response = await (this.options.fetch ?? globalThis.fetch)(this.options.endpoint, { method: "POST", mode: "cors", credentials: "omit",
          headers, body, signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          if (response.status === 415 && headers["Content-Encoding"] === "gzip") { this.gzipUnavailable = true; continue; }
          throw new Error("Telemetry temporarily unavailable");
        }
        const receipt = z.object({ accepted: z.array(z.uuid()).max(20), duplicates: z.array(z.uuid()).max(20),
          rejected: z.array(z.object({ event_id: z.uuid(), code: z.string().max(80) })).max(20), achievement_events: z.number().int().positive().optional() }).passthrough().parse(await response.json());
        const supported = receipt.achievement_events === 1;
        const acknowledged = new Set([...receipt.accepted, ...receipt.duplicates,
          ...receipt.rejected.filter(item => supported || !achievementIds.has(item.event_id)).map(item => item.event_id)].filter(id => ids.has(id)));
        if (generation === this.consentGeneration) await this.update(() => {
          if (supported) this.state.achievement_capability_endpoint = this.options.endpoint;
          else if (achievementIds.size) this.state.achievement_capability_endpoint = undefined;
          this.state.pending = this.state.pending.filter(item => !acknowledged.has(item.event.event_id));
          this.state.achievement_pending = this.state.achievement_pending.filter(item => !acknowledged.has(item.event.event_id));
        });
        if (!acknowledged.size && !(achievementIds.size && !supported)) throw new Error("No telemetry receipt");
        this.retryCount = 0;
      } catch {
        if (this.enabled) {
          const delay = Math.min(300_000, 2000 * 2 ** Math.min(this.retryCount++, 8)) * (0.8 + Math.random() * 0.4);
          this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.kick(); }, delay);
          (this.retryTimer as unknown as { unref?: () => void }).unref?.();
        }
        return;
      } finally { clearTimeout(timeout); if (this.request === controller) this.request = undefined; }
    }
  }
}
