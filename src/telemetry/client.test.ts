import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { createMatch, gameReducer } from "../core/match/reducer";
import { singleMatchFlow } from "../runtime/encounter-snapshot";
import { TelemetryClient } from "./client";
import { gunzipSync } from "node:zlib";
import { ACHIEVEMENT_EVENT_MAX_BYTES, telemetryByteLength } from "./achievement-protocol";
import { gunStatistics, summarizeTelemetry } from "./summary";
import type { TelemetryEvent } from "./types";

const clients: TelemetryClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.setEnabled(false))); vi.useRealTimers(); });
function client(driver = new MemorySaveStorageDriver(), transport = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch, now = () => Date.now()) {
  const value = new TelemetryClient({ endpoint: "https://events.example/v1/events", environment: "test", gameVersion: "test-version", buildId: "fixture",
    client: { type: "web", os: "test", browser: "test", browser_major: "1", locale: "zh-CN" }, driver, fetch: transport, now });
  clients.push(value); return value;
}
const fresh = () => createMatch("telemetry-fixture", { opponentId: "chatgpt", opponentAiSkills: [] });
const achievementKey = (id: string) => `example/achievements#main/${id}`;
const unlock = (id: string, allowDebug = false) => ({ key: achievementKey(id), completion: { revision: 1, at: "2026-11-10T01:00:00.000Z" }, allowDebug });
function requestEvents(init?: RequestInit): TelemetryEvent[] {
  const body = new Headers(init?.headers).get("content-encoding") === "gzip"
    ? gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString("utf8") : String(init?.body);
  return JSON.parse(body).events;
}
const receipt = (events: readonly TelemetryEvent[], capable = true) => new Response(JSON.stringify({
  accepted: events.map(event => event.event_id), duplicates: [], rejected: [], ...(capable ? { achievement_events: 1 } : {})
}));
describe("local telemetry outbox", () => {
  it("keeps IDs and summaries across offline reload, separates launch IDs, and removes only acknowledged events", async () => {
    const driver = new MemorySaveStorageDriver(), first = client(driver), match = fresh(), run = singleMatchFlow(match);
    await first.start(); await first.observe(match, run); await first.observe(gameReducer(match, { type: "ESCAPE_MATCH" }), run); await first.drain();
    const before = (await driver.readSnapshot())!.longTerm as { installation_id: string; pending: { event: TelemetryEvent }[] };
    expect(before.pending.map(item => item.event.event_type)).toEqual(["app_started", "match_finished"]);
    const delivered: TelemetryEvent[] = [];
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = JSON.parse(String(init?.body)).events as TelemetryEvent[]; delivered.push(...events);
      return new Response(JSON.stringify({ accepted: events.map(event => event.event_id), duplicates: [], rejected: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const second = client(driver, send); await second.start(); await second.drain();
    await vi.waitFor(() => expect(second.pendingCount).toBe(0));
    const launches = delivered.filter(event => event.event_type === "app_started");
    expect(new Set(launches.map(event => event.installation_id))).toEqual(new Set([before.installation_id]));
    expect(new Set(launches.map(event => event.session_id)).size).toBe(2);
    expect(delivered.find(event => event.event_type === "match_finished")!.event_id).toBe(before.pending[1]!.event.event_id);
  });
  it("reports each match once on repeated finish and restored summaries", async () => {
    const driver = new MemorySaveStorageDriver(), value = client(driver), match = fresh(), run = singleMatchFlow(match);
    await value.start(); await value.observe(match, run);
    const ended = gameReducer(match, { type: "ESCAPE_MATCH" });
    await value.observe(ended, run); await value.observe(ended, run); await value.drain();
    const restored = client(driver); await restored.start(); await restored.observe(ended, run, { restored: true }); await restored.drain();
    const state = (await driver.readSnapshot())!.longTerm as { pending: { event: TelemetryEvent }[] };
    expect(state.pending.filter(item => item.event.event_type === "match_finished")).toHaveLength(1);
  });
  it("retains observed debug use across reload and a later disabled observation", async () => {
    const driver = new MemorySaveStorageDriver(), first = client(driver), match = fresh(), run = singleMatchFlow(match);
    await first.observe(match, run, { debugUsed: false });
    await first.observe(match, run, { debugUsed: true });
    await first.drain();
    const restored = client(driver);
    await restored.observe(gameReducer(match, { type: "ESCAPE_MATCH" }), run, { restored: true, debugUsed: false });
    await restored.drain();
    const state = (await driver.readSnapshot())!.longTerm as { pending: { event: TelemetryEvent }[] };
    const event = state.pending.find(item => item.event.event_type === "match_finished")!.event;
    expect(event.event_type === "match_finished" && event.data.debug_used).toBe(true);
  });
  it("reads the saved launcher preference without sending or queuing a launch event", async () => {
    const driver = new MemorySaveStorageDriver();
    await client(driver).setEnabled(false);
    const before = await driver.readSnapshot();
    const transport = vi.fn(); const restored = client(driver, transport);
    await restored.ready();
    expect(restored.enabled).toBe(false); expect(restored.pendingCount).toBe(0);
    expect(await driver.readSnapshot()).toEqual(before);
    expect(transport).not.toHaveBeenCalled();
  });
  it("opt-out clears queued data and remains disabled after a restart", async () => {
    const driver = new MemorySaveStorageDriver(), value = client(driver); await value.start(); await value.drain();
    await value.setEnabled(false); expect(value.pendingCount).toBe(0);
    const transport = vi.fn(); const restored = client(driver, transport); await restored.start(); await restored.drain();
    expect(restored.enabled).toBe(false); expect(transport).not.toHaveBeenCalled();
  });
  it("expires old queued events and accepts duplicate and permanent-rejection receipts", async () => {
    let now = Date.parse("2026-10-01T00:00:00Z"); const driver = new MemorySaveStorageDriver(), value = client(driver, undefined, () => now);
    await value.start(); await value.drain(); now += 8 * 86_400_000;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = JSON.parse(String(init?.body)).events as TelemetryEvent[];
      return new Response(JSON.stringify({ accepted: [], duplicates: [events[0]!.event_id], rejected: [] }));
    });
    const restored = client(driver, transport, () => now); await restored.start(); await restored.drain();
    await vi.waitFor(() => expect(restored.pendingCount).toBe(0));
    expect(transport.mock.calls[0]![1]!.body).not.toContain("2026-10-01");
  });
  it("persists foreground duration while excluding time in the background", async () => {
    let now = 1000;
    const driver = new MemorySaveStorageDriver(), value = new TelemetryClient({ endpoint: "https://events.example/v1/events", environment: "test",
      gameVersion: "test", buildId: "", client: { type: "android", os: "Android", browser: "Chromium", browser_major: "150", locale: "zh-CN" },
      driver, clock: () => now, fetch: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    clients.push(value); const match = fresh(), run = singleMatchFlow(match);
    await value.start(); await value.observe(match, run); now += 500; await value.setVisible(false);
    now += 60_000; await value.setVisible(true); now += 250; await value.observe(gameReducer(match, { type: "ESCAPE_MATCH" }), run);
    const state = (await driver.readSnapshot())!.longTerm as { pending: { event: TelemetryEvent }[] };
    const event = state.pending.find(item => item.event.event_type === "match_finished")!.event;
    expect(event.event_type === "match_finished" && event.data.duration_ms).toBe(750);
  });
  it("preserves a pending event when a forged receipt acknowledges some other event", async () => {
    const value = client(undefined, vi.fn(async () => new Response(JSON.stringify({ accepted: [crypto.randomUUID()], duplicates: [], rejected: [] }))) as typeof fetch);
    await value.start(); await value.drain(); expect(value.pendingCount).toBe(1);
  });
});

describe("durable lightweight achievement telemetry", () => {
  it("hashes only sorted keys/revisions, suppresses repeated catalogs, and reports an empty unload once", async () => {
    const driver = new MemorySaveStorageDriver(), value = client(driver);
    await value.recordAchievementCatalog([]);
    expect(value.pendingCount).toBe(0);
    const entries = [
      { key: achievementKey("second"), definition: { revision: 2, name: "private name", description: "private description", icon: "private.png", tracking: { secret: true } } },
      { key: achievementKey("first"), definition: { revision: 1 } }
    ];
    await value.recordAchievementCatalog(entries);
    await value.recordAchievementCatalog([...entries].reverse());
    await value.recordAchievementCatalog([]);
    await value.recordAchievementCatalog([]);
    await value.recordAchievementCatalog([{ key: achievementKey("first"), definition: { revision: 3 } }]);
    const state = (await driver.readSnapshot())!.longTerm as any;
    expect(state.pending).toEqual([]);
    expect(state.achievement_pending).toHaveLength(3);
    const events = state.achievement_pending.map((item: any) => item.event);
    expect(events[0].data.items).toEqual([[achievementKey("first"), 1], [achievementKey("second"), 2]]);
    expect(events[1].data.items).toEqual([]);
    expect(new Set(events.map((event: any) => event.data.catalog_hash)).size).toBe(3);
    for (const omitted of ["private name", "private description", "private.png", "tracking", "secret"]) expect(JSON.stringify(events)).not.toContain(omitted);
  });

  it("deduplicates permanent achievement identities across calls, revisions and reload without changing existing batches", async () => {
    const driver = new MemorySaveStorageDriver(), first = client(driver);
    await first.recordAchievementUnlocks([unlock("first"), unlock("first"), unlock("second", true)]);
    const before = structuredClone((await driver.readSnapshot())!.longTerm) as any;
    const second = client(driver);
    await second.recordAchievementUnlocks([{ ...unlock("first"), completion: { revision: 2, at: "2026-11-10T02:00:00.000Z" } }, unlock("third")]);
    const after = (await driver.readSnapshot())!.longTerm as any;
    expect(after.installation_id).toBe(before.installation_id);
    expect(after.achievement_pending[0]).toEqual(before.achievement_pending[0]);
    expect(after.achievement_pending.flatMap((item: any) => item.event.data.items)).toEqual([
      [achievementKey("first"), 1, unlock("first").completion.at, false],
      [achievementKey("second"), 1, unlock("second").completion.at, true],
      [achievementKey("third"), 1, unlock("third").completion.at, false]
    ]);
    expect(after.pending).toEqual([]);
  });

  it.each(["catalog", "unlock"] as const)("rolls back both private receipts and pending %s batches when persistence fails", async kind => {
    const driver = new MemorySaveStorageDriver(), value = client(driver);
    vi.spyOn(driver, "writeSnapshot").mockRejectedValueOnce(new Error("disk full"));
    const record = () => kind === "catalog" ? value.recordAchievementCatalog([{ key: achievementKey("first"), definition: { revision: 1 } }]) : value.recordAchievementUnlocks([unlock("first")]);
    await expect(record()).rejects.toThrow("disk full");
    expect(value.pendingCount).toBe(0);
    await record();
    expect(value.pendingCount).toBe(1);
    const state = (await driver.readSnapshot())!.longTerm as any;
    expect(kind === "catalog" ? state.achievement_catalogs.length : state.achievement_keys.length).toBe(1);
  });

  it("keeps optional achievement data separate from the legacy outbox and preserves old preferences/identity", async () => {
    const driver = new MemorySaveStorageDriver(), first = client(driver);
    await first.start(); await first.drain();
    const legacy = (await driver.readSnapshot())!.longTerm as any;
    const oldState = { version: legacy.version, installation_id: legacy.installation_id, enabled: legacy.enabled, pending: legacy.pending, matches: legacy.matches };
    await driver.writeSnapshot({ longTerm: oldState, runtime: null });
    const current = client(driver);
    await current.recordAchievementUnlocks([unlock("first")]);
    const stored = (await driver.readSnapshot())!.longTerm as any;
    expect(stored.installation_id).toBe(legacy.installation_id);
    expect(stored.pending).toEqual(legacy.pending);
    expect(stored.pending.every((item: any) => ["app_started", "match_finished"].includes(item.event.event_type))).toBe(true);
    expect(stored.achievement_pending).toHaveLength(1);
    // Corruption confined to optional new fields must not reset the original installation.
    await driver.writeSnapshot({ longTerm: { ...stored, achievement_pending: "invalid" }, runtime: null });
    const recovered = client(driver); await recovered.ready();
    expect(recovered.enabled).toBe(true);
    await recovered.recordAchievementUnlocks([unlock("first")]);
    expect(((await driver.readSnapshot())!.longTerm as any).achievement_pending).toHaveLength(1);
    await recovered.flush();
    expect(((await driver.readSnapshot())!.longTerm as any).installation_id).toBe(legacy.installation_id);
  });

  it("does not reinterpret a transient read failure as a new installation or renewed consent", async () => {
    const driver = new MemorySaveStorageDriver(); await client(driver).setEnabled(false);
    const before = await driver.readSnapshot();
    vi.spyOn(driver, "readSnapshot").mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    const restored = client(driver);
    await expect(restored.recordAchievementUnlocks([unlock("first")])).rejects.toThrow("storage temporarily unavailable");
    expect(await driver.readSnapshot()).toEqual(before);
    await restored.recordAchievementUnlocks([unlock("first")]);
    expect(restored.enabled).toBe(false); expect(restored.pendingCount).toBe(0);
    expect(await driver.readSnapshot()).toEqual(before);
  });

  it("waits for a base-event capability receipt and then sends queued batches without another handshake request", async () => {
    const batches: TelemetryEvent[][] = [], transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = requestEvents(init); batches.push(events); return receipt(events);
    }) as typeof fetch;
    const value = client(undefined, transport);
    await value.recordAchievementCatalog([{ key: achievementKey("first"), definition: { revision: 1 } }]);
    await value.recordAchievementUnlocks([unlock("first")]);
    await value.drain(); expect(transport).not.toHaveBeenCalled();
    await value.start(); await value.drain();
    expect(batches).toHaveLength(2);
    expect(batches[0].map(event => event.event_type)).toEqual(["app_started"]);
    expect(batches[1].map(event => event.event_type)).toEqual(["achievements_loaded", "achievements_unlocked"]);
    expect(value.pendingCount).toBe(0);
  });

  it("retains achievement batches at an old receiver and delivers them after a later base event advertises support", async () => {
    let capable = false;
    const driver = new MemorySaveStorageDriver(), delivered: TelemetryEvent[] = [];
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { const events = requestEvents(init); delivered.push(...events); return receipt(events, capable); }) as typeof fetch;
    const first = client(driver, transport);
    await first.recordAchievementUnlocks([unlock("first")]);
    await first.start(); await first.drain();
    expect(first.pendingCount).toBe(1);
    expect(delivered.every(event => event.event_type === "app_started")).toBe(true);
    capable = true;
    const second = client(driver, transport); await second.start(); await second.drain();
    expect(second.pendingCount).toBe(0);
    expect(delivered.filter(event => event.event_type === "achievements_unlocked")).toHaveLength(1);
  });

  it("does not consume permanent invalid_event rejections from a receiver that lost its capability", async () => {
    let capable = true;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = requestEvents(init);
      return capable ? receipt(events) : new Response(JSON.stringify({ accepted: [], duplicates: [], rejected: events.map(event => ({ event_id: event.event_id, code: "invalid_event" })) }));
    }) as typeof fetch;
    const value = client(undefined, transport); await value.start(); await value.drain();
    capable = false;
    await value.recordAchievementUnlocks([unlock("first")]); await value.drain();
    expect(value.pendingCount).toBe(1);
    const calls = vi.mocked(transport).mock.calls.length;
    await value.drain();
    expect(vi.mocked(transport).mock.calls).toHaveLength(calls);
  });

  it("retries the identical immutable batch after receipt persistence fails", async () => {
    const driver = new MemorySaveStorageDriver(), delivered: TelemetryEvent[][] = [];
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { const events = requestEvents(init); delivered.push(structuredClone(events)); return receipt(events); }) as typeof fetch;
    const value = client(driver, transport); await value.start(); await value.drain();
    await value.recordAchievementUnlocks([unlock("first")]);
    const write = driver.writeSnapshot.bind(driver); let fail = true;
    vi.spyOn(driver, "writeSnapshot").mockImplementation(async snapshot => {
      if (fail && (snapshot.longTerm as any).achievement_pending.length === 0) { fail = false; throw new Error("receipt save failed"); }
      return write(snapshot);
    });
    await value.drain(); expect(value.pendingCount).toBe(1);
    await value.drain(); expect(value.pendingCount).toBe(0);
    expect(delivered[1]).toEqual(delivered[2]);
  });

  it("bounds tuple counts and encoded event/request bytes while preserving every completion", async () => {
    const requests: TelemetryEvent[][] = [];
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { const events = requestEvents(init); requests.push(events); return receipt(events); }) as typeof fetch;
    const value = client(undefined, transport); await value.start(); await value.drain(); requests.length = 0;
    const entries = Array.from({ length: 300 }, (_, index) => ({ ...unlock(`item-${index}`), key: `example/${"p".repeat(350)}#main/item-${index}` }));
    await value.recordAchievementCatalog(entries.map(entry => ({ key: entry.key, definition: { revision: 1 } })));
    await value.recordAchievementUnlocks(entries); await value.drain();
    const events = requests.flat();
    for (const request of requests) { expect(request.length).toBeLessThanOrEqual(20); expect(telemetryByteLength({ events: request })).toBeLessThanOrEqual(60_000); }
    for (const event of events) {
      expect(telemetryByteLength(event)).toBeLessThanOrEqual(ACHIEVEMENT_EVENT_MAX_BYTES);
      if (event.event_type === "achievements_loaded") expect(event.data.items.length).toBeLessThanOrEqual(64);
      if (event.event_type === "achievements_unlocked") expect(event.data.items.length).toBeLessThanOrEqual(128);
    }
    const loaded = events.filter(event => event.event_type === "achievements_loaded");
    expect(loaded.flatMap(event => event.data.items)).toHaveLength(300);
    expect(loaded.every((event, index) => event.data.part === index && event.data.parts === loaded.length)).toBe(true);
    expect(events.filter(event => event.event_type === "achievements_unlocked").flatMap(event => event.data.items)).toHaveLength(300);
  });

  it("debounces durable events into one compressed HTTP request only when compression saves enough bytes", async () => {
    vi.useFakeTimers();
    const requests: RequestInit[] = [];
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { requests.push(init!); return receipt(requestEvents(init)); }) as typeof fetch;
    const value = client(undefined, transport); await value.start(); await value.drain(); requests.length = 0;
    await value.recordAchievementUnlocks(Array.from({ length: 10 }, (_, index) => unlock(`first-${index}`)));
    await value.recordAchievementUnlocks(Array.from({ length: 10 }, (_, index) => unlock(`second-${index}`)));
    await vi.advanceTimersByTimeAsync(499); expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await value.drain();
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0].headers).get("content-encoding")).toBe("gzip");
    const events = requestEvents(requests[0]);
    expect(events).toHaveLength(2);
    expect((requests[0].body as ArrayBuffer).byteLength + 128).toBeLessThanOrEqual(telemetryByteLength({ events }));
  });

  it("falls back to uncompressed JSON after a receiver rejects gzip", async () => {
    const requests: RequestInit[] = [];
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(init!);
      return new Headers(init?.headers).has("content-encoding") ? new Response("", { status: 415 }) : receipt(requestEvents(init));
    }) as typeof fetch;
    const value = client(undefined, transport); await value.start(); await value.drain(); requests.length = 0;
    await value.recordAchievementUnlocks(Array.from({ length: 20 }, (_, index) => unlock(`item-${index}`))); await value.drain();
    expect(requests).toHaveLength(2);
    expect(requestEvents(requests[0])).toEqual(requestEvents(requests[1]));
    expect(new Headers(requests[1].headers).has("content-encoding")).toBe(false);
    expect(value.pendingCount).toBe(0);
  });

  it("applies persisted opt-out to both new queues and never backfills ignored completions", async () => {
    const driver = new MemorySaveStorageDriver(), first = client(driver); await first.setEnabled(false);
    await first.recordAchievementCatalog([{ key: achievementKey("first"), definition: { revision: 1 } }]);
    await first.recordAchievementUnlocks([unlock("first")]); expect(first.pendingCount).toBe(0);
    const restored = client(driver); await restored.ready(); expect(restored.enabled).toBe(false);
    await restored.setEnabled(true);
    const state = (await driver.readSnapshot())!.longTerm as any;
    expect(state.achievement_pending).toEqual([]); expect(state.achievement_keys).toEqual([]);
  });

  it("backpressures a full achievement outbox without discarding an older undelivered event or marking the new key", async () => {
    const driver = new MemorySaveStorageDriver(), first = client(driver);
    await first.recordAchievementUnlocks([unlock("first")]);
    const initial = (await driver.readSnapshot())!.longTerm as any;
    initial.achievement_pending = Array.from({ length: 1000 }, (_, index) => ({ queued_at: Date.now(), event: {
      ...initial.achievement_pending[0].event, event_id: crypto.randomUUID(), data: { items: [[achievementKey(`old-${index}`), 1, unlock("first").completion.at, false]] }
    } }));
    initial.achievement_keys = initial.achievement_pending.flatMap((item: any) => item.event.data.items.map((entry: any) => entry[0]));
    await driver.writeSnapshot({ longTerm: initial, runtime: null });
    const restored = client(driver);
    await expect(restored.recordAchievementUnlocks([unlock("new")])).rejects.toThrow("capacity exceeded");
    expect(restored.pendingCount).toBe(1000);
    expect((await driver.readSnapshot())!.longTerm).toEqual(initial);
  });

  it("samples the current catalog after opt-in without recursively entering the storage queue", async () => {
    const driver = new MemorySaveStorageDriver();
    let catalog = [{ key: achievementKey("first"), definition: { revision: 1 } }];
    const value = new TelemetryClient({ endpoint: "https://events.example/v1/events", environment: "test", gameVersion: "test", buildId: "fixture",
      client: { type: "web", os: "test", browser: "test", browser_major: "1", locale: "zh-CN" }, driver,
      getAchievementCatalog: () => catalog, fetch: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch });
    clients.push(value);
    await value.setEnabled(false);
    catalog = [{ key: achievementKey("second"), definition: { revision: 2 } }];
    await value.setEnabled(true);
    const stored = (await driver.readSnapshot())!.longTerm as any;
    expect(stored.achievement_pending.map((item: any) => item.event.data.items)).toEqual([[[achievementKey("second"), 2]]]);
  });

  it.each(["missing", "unsupported", "ineffective"])("keeps JSON transport when CompressionStream is %s", async mode => {
    const native = globalThis.CompressionStream;
    const replacement = mode === "missing" ? undefined : mode === "unsupported" ? function () { throw new Error("unsupported"); }
      : function () { return new TransformStream(); };
    vi.stubGlobal("CompressionStream", replacement);
    try {
      const requests: RequestInit[] = [];
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => { requests.push(init!); return receipt(requestEvents(init)); }) as typeof fetch;
      const value = client(undefined, transport); await value.start(); await value.drain(); requests.length = 0;
      await value.recordAchievementUnlocks(Array.from({ length: 20 }, (_, index) => unlock(`item-${index}`))); await value.drain();
      expect(requests).toHaveLength(1);
      expect(new Headers(requests[0].headers).has("content-encoding")).toBe(false);
      expect(requestEvents(requests[0])[0].event_type).toBe("achievements_unlocked");
    } finally { vi.stubGlobal("CompressionStream", native); }
  });
});
describe("gameplay event aggregation", () => {
  it("counts actual capped loading, skill additions and removals without conflating active plays and rule triggers", () => {
    const match = fresh(), run = singleMatchFlow(match);
    const ended = { ...gameReducer(match, { type: "ESCAPE_MATCH" }), history: [
      { type: "BULLET_ADDED" as const, actor: "player" as const, amount: 3, actualAmount: 1 },
      { type: "ABILITY_RESULT" as const, definitionId: "example", instanceId: "a", owner: "player" as const, result: { type: "gun-bullets-added" as const, actor: "player" as const, amount: -2, bullets: 3 } },
      { type: "ABILITY_RESULT" as const, definitionId: "example", instanceId: "a", owner: "player" as const, result: { type: "gun-bullets-added" as const, actor: "player" as const, amount: 1, bullets: 4 } },
      { type: "ABILITY_PLAYED" as const, definitionId: "example", instanceId: "a", owner: "player" as const },
      { type: "ABILITY_TRIGGERED" as const, definitionId: "example", instanceId: "a", owner: "player" as const, ruleId: "rule-a" },
      { type: "ABILITY_TRIGGERED" as const, definitionId: "example", instanceId: "a", owner: "player" as const, ruleId: "rule-b" }
    ] };
    const data = summarizeTelemetry(ended, run, { matchId: crypto.randomUUID(), startedAt: null, endedAt: new Date().toISOString(), durationMs: null,
      restored: false, initial: { player: 5, opponent: 0 }, debugUsed: false, opponent: { id: "chatgpt", name: "示例" } });
    expect(data.guns.player).toMatchObject({ loaded_actual: 2, removed_actual: 2, load_requested: 3 });
    expect(data.skills).toEqual([{ id: "example", level: 1, owner: "player", plays: 1, rule_triggers: 2 }]);
  });
  it("marks legacy penalty logs without actual increments as incomplete rather than inventing counts", () => {
    const match = { ...fresh(), history: [{ type: "BULLET_ADDED" as const, actor: "player" as const, amount: 4 }] };
    expect(gunStatistics(match, "player", 0).loaded_actual).toBeNull();
  });
});

it.each(["player", "opponent"] as const)("counts only actual %s shots with known pre-shot loads, keeping legacy samples unknown", actor => {
  const match = fresh();
  const trigger = (result: "fired" | "empty-chamber" | "misfire", bulletsBefore?: number) => ({
    type: "TRIGGER_PULLED" as const, actor, probability: .5, baseProbability: .5, misfireChance: 0,
    fired: result === "fired", result, ...(bulletsBefore === undefined ? {} : { bulletsBefore, capacityBefore: 6 })
  });
  const state = { ...match, history: [trigger("fired", 2), trigger("empty-chamber", 4), trigger("misfire", 5), trigger("fired"), trigger("fired", 2), trigger("fired", 6)] };
  expect(gunStatistics(state, actor, 0)).toMatchObject({ fired: 4, triggers: 6,
    firing_bullets: [{ bullets: 2, count: 2 }, { bullets: 6, count: 1 }] });
});
