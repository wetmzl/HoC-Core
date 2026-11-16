import { expect, it, vi } from "vitest";
import { createMatch } from "../core/match/reducer";
import { createProgramRun, programMatchId } from "../core/flow/program-engine";
import { ProgramDefinitionSchema } from "../core/flow/program";
import { createMatchFactBatch } from "../core/events";
import { matchPublicEventBatch, type PublicEventBatch } from "../core/events/public-events";
import { selectPublicTriggerEvents } from "../core/events/triggers";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { ProgramSession } from "./program-session";
import { MatchSession, type MatchSessionDependencies } from "./match-session";
import { RuntimeEventHub } from "./public-event-hub";

vi.mock("../audio/game-audio", () => ({ gameAudio: {
  updateMusicFacts: vi.fn(), updateMusicContext: vi.fn(), play: vi.fn(), startHeartbeat: vi.fn(), stopHeartbeat: vi.fn()
} }));

it("routes one real table through program, skill windows and declarative consumers with the same scopes and identities", async () => {
  const events = new RuntimeEventHub();
  const resolved: PublicEventBatch[] = [], committed: PublicEventBatch[] = [], order: string[] = [];
  events.subscribe("resolved", batch => { resolved.push(batch); if (batch.facts.some(fact => fact.type === "match.PLAYER_STOOD")) order.push("public"); });
  events.subscribe("committed", batch => { committed.push(batch); });
  let save = createDefaultSave();
  const repository = new MemorySaveRepository({ longTerm: save });
  const program = new ProgramSession(repository, { get: () => save, set: next => { save = next; } }, undefined, undefined, events, { game: "integration-game" });
  const definition = ProgramDefinitionSchema.parse({ version: 2, id: "integration-flow", start: "table", nodes: [
    { id: "table", type: "match", opponentId: "llama", routes: { victory: "end", defeat: "end", escaped: "end" } },
    { id: "end", type: "end", result: "victory" }
  ] });
  await program.begin(createProgramRun("integration-program", "integration-seed", definition));
  const state = createMatch("session-transition", { id: programMatchId(program.run!), opponentId: "llama", grantOpeningSkills: false });
  const handle = await program.attach(program.run!, state);
  const scopes = { game: "integration-game", program: program.run!.id };
  const initial = matchPublicEventBatch(createMatchFactBatch(undefined, state), scopes);
  events.publish("resolved", initial);
  expect(selectPublicTriggerEvents({ on: ["match.created"], when: { type: "compare",
    left: { type: "query", query: { id: "match.player-turn" } }, operator: "eq", right: { type: "literal", value: true }
  } }, initial)).toHaveLength(1);
  const table = new MatchSession({ events, eventScopes: scopes, save, runtimeContributions: [],
    renderMatch: () => order.push("render"), presentDelta() {}, notifyExtensions() {},
    scheduleAiTurn: () => order.push("ai"), clearAiSchedule() {}
  } as unknown as MatchSessionDependencies);
  table.autosave = handle;
  table.dispatch({ type: "PLAYER_STAND" });
  expect(order).toEqual(["render", "public", "ai"]);
  await program.flush();
  const immediate = resolved.find(batch => batch.facts.some(event => event.type === "match.PLAYER_STOOD"))!;
  const durable = committed.find(batch => batch.facts.some(event => event.type === "match.PLAYER_STOOD"))!;
  expect(immediate.facts.map(event => event.id)).toEqual(durable.facts.map(event => event.id));
  expect(immediate.facts.every(event => event.scopes.game === scopes.game && event.scopes.program === scopes.program)).toBe(true);
  expect(immediate.facts.some(event => event.type === "rule.after-stand")).toBe(true);
  const stand = immediate.facts.find(event => event.type === "match.PLAYER_STOOD")!;
  expect(stand.id).toBe(stand.origin!.factId);
  events.publish("resolved", immediate);
  expect(resolved.filter(batch => batch.facts.some(event => event.id === stand.id))).toHaveLength(1);
  const count = committed.length;
  events.publish("committed", matchPublicEventBatch(createMatchFactBatch(undefined, handle.getState(), { restored: true }), scopes));
  expect(committed).toHaveLength(count);
  await table.dispose();
  await program.dispose();
  events.dispose();
});
