import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { createMatch, gameReducer } from "../core/match/reducer";
import { singleMatchFlow } from "../runtime/encounter-snapshot";
import { TelemetryClient } from "./client";
import { gunStatistics, summarizeTelemetry } from "./summary";
import type { TelemetryEvent } from "./types";

const clients: TelemetryClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.setEnabled(false))); });
function client(driver = new MemorySaveStorageDriver(), transport = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch, now = () => Date.now()) {
  const value = new TelemetryClient({ endpoint: "https://events.example/v1/events", environment: "test", gameVersion: "test-version", buildId: "fixture",
    client: { type: "web", os: "test", browser: "test", browser_major: "1", locale: "zh-CN" }, driver, fetch: transport, now });
  clients.push(value); return value;
}
const fresh = () => createMatch("telemetry-fixture", { opponentId: "chatgpt", opponentAiSkills: [] });
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
