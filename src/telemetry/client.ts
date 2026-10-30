import { z } from "zod";
import type { SaveStorageDriver } from "../persistence/storage-driver";
import type { MatchState } from "../core/match/types";
import type { TelemetryFlow as FlowRun } from "./types";
import { gunStatistics, summarizeTelemetry } from "./summary";
import type { ClientMetadata, EncounterTelemetry, MatchObservation, MatchStatistics, TelemetryEvent } from "./types";

const MAX_PENDING = 1000, MAX_AGE = 7 * 86_400_000;
const StoredEvent = z.object({ schema_version: z.literal(1), event_id: z.uuid(), installation_id: z.uuid(), session_id: z.uuid(),
  occurred_at: z.string(), event_type: z.enum(["app_started", "match_finished"]) }).passthrough();
const MatchMetadata = z.object({ source_id: z.string(), match_id: z.uuid(), event_id: z.uuid(), started_at: z.string().nullable(),
  initial: z.object({ player: z.number().int().nonnegative(), opponent: z.number().int().nonnegative() }).nullable(),
  elapsed_ms: z.number().nonnegative(), restored: z.boolean(), debug_used: z.boolean(), finished: z.boolean(),
  ended_at: z.string().optional(), configuration_hash: z.string().optional() });
const State = z.object({ version: z.literal(1), installation_id: z.uuid(), enabled: z.boolean(),
  pending: z.array(z.object({ queued_at: z.number(), event: StoredEvent })).max(MAX_PENDING),
  matches: z.array(MatchMetadata).max(MAX_PENDING) });
type StateValue = Omit<z.infer<typeof State>, "pending"> & { pending: { queued_at: number; event: TelemetryEvent }[] };
export interface ClientOptions {
  endpoint: string; environment: TelemetryEvent["environment"]; gameVersion: string; buildId: string; client: ClientMetadata;
  driver: SaveStorageDriver; fetch?: typeof fetch; now?: () => number; clock?: () => number; uuid?: () => string;
  opponent?: (id: string) => MatchStatistics["opponent"];
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
  get pendingCount(): number { return this.state?.pending.length ?? 0; }
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      try { this.state = State.parse((await this.options.driver.readSnapshot())?.longTerm) as unknown as StateValue; }
      catch { this.state = { version: 1, installation_id: this.uuid(), enabled: true, pending: [], matches: [] }; }
      this.prune();
    })();
  }
  private prune(): void {
    this.state.pending = this.state.pending.filter(item => item.queued_at >= this.now() - MAX_AGE).slice(-MAX_PENDING);
    if (this.state.matches.length > MAX_PENDING) this.state.matches = this.state.matches.slice(-MAX_PENDING);
  }
  private async persist(): Promise<void> {
    this.prune();
    try { await this.options.driver.writeSnapshot({ longTerm: structuredClone(this.state), runtime: null }); this.persistent = true; }
    catch (error) { this.persistent = false; throw error; }
  }
  private update(operation: () => void | Promise<void>): Promise<void> {
    const result = this.writing.catch(() => undefined).then(async () => { await this.load(); await operation(); await this.persist(); });
    this.writing = result.catch(() => undefined);
    return result;
  }
  private envelope(eventId: string) {
    return { schema_version: 1 as const, event_id: eventId, installation_id: this.state.installation_id, session_id: this.sessionId,
      occurred_at: new Date(this.now()).toISOString(), game_version: this.options.gameVersion, build_id: this.options.buildId,
      environment: this.options.environment, client: this.options.client };
  }
  private append(event: TelemetryEvent): void {
    if (!this.state.pending.some(item => item.event.event_id === event.event_id)) this.state.pending.push({ queued_at: this.now(), event });
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
    await this.update(() => { this.state.enabled = enabled; if (!enabled) { this.state.pending = []; this.state.matches = []; this.ticks.clear(); }
      else this.append({ ...this.envelope(this.startEventId), event_type: "app_started", data: { storage: this.persistent ? "persistent" : "ephemeral" } }); });
    if (enabled) this.kick();
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
    if (this.sending) { this.resendRequested = true; return; }
    void this.drain().catch(() => undefined);
  }
  drain(): Promise<void> {
    return this.sending ??= this.sendPending().finally(() => {
      this.sending = undefined;
      if (this.resendRequested) { this.resendRequested = false; this.kick(); }
    });
  }
  private async sendPending(): Promise<void> {
    await this.load(); await this.update(() => undefined);
    while (this.enabled && this.state.pending.length) {
      const generation = this.consentGeneration;
      const batch: TelemetryEvent[] = [];
      for (const item of this.state.pending.slice(0, 20)) {
        if (new TextEncoder().encode(JSON.stringify({ events: [...batch, item.event] })).byteLength > 60_000) break;
        batch.push(item.event);
      }
      if (!batch.length) { await this.update(() => { this.state.pending.shift(); }); continue; }
      const ids = new Set(batch.map(event => event.event_id));
      const controller = new AbortController(); this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(this.options.endpoint, { method: "POST", mode: "cors", credentials: "omit",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: batch }), signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Telemetry temporarily unavailable");
        const receipt = z.object({ accepted: z.array(z.uuid()).max(20), duplicates: z.array(z.uuid()).max(20),
          rejected: z.array(z.object({ event_id: z.uuid(), code: z.string().max(80) })).max(20) }).passthrough().parse(await response.json());
        const acknowledged = new Set([...receipt.accepted, ...receipt.duplicates, ...receipt.rejected.map(item => item.event_id)].filter(id => ids.has(id)));
        if (!acknowledged.size) throw new Error("No telemetry receipt");
        if (generation === this.consentGeneration) await this.update(() => { this.state.pending = this.state.pending.filter(item => !acknowledged.has(item.event.event_id)); });
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
