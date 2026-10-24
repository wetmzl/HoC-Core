import { expect, it, vi } from "vitest";
import { createMatch } from "../core/match/reducer";
import type { GameEvent, MatchState } from "../core/match/types";
import { extractDialogueEvents, restoreDialogueEvent } from "./events";
import { CORE_DIALOGUE_PRIMITIVES } from "./facts";
import { DialogueEngine } from "./engine";
import { DialogueSession } from "./session";
import { MemoryPresentationDriver, PresentationStore } from "../persistence/presentation";
import type { CharacterDialogue, DialoguePrimitiveContext } from "./types";

const played: GameEvent = { type: "ABILITY_PLAYED", definitionId: "neutral-active", instanceId: "active-card", owner: "player" };
const triggered: GameEvent = { type: "ABILITY_TRIGGERED", definitionId: "neutral-passive", instanceId: "passive", owner: "opponent", ruleId: "on-acquire" };
const base = () => createMatch("ability-dialogue");
const append = (state: MatchState, events: readonly GameEvent[]): MatchState => ({ ...state, history: [...state.history, ...events] });
const read = (name: string, context: DialoguePrimitiveContext, args = {}) => CORE_DIALOGUE_PRIMITIVES.find(p => p.id === `core.${name}`)!.read(context, args);
const program: CharacterDialogue = { pools: { fallback: ["基础"], action: ["行动"], ability: ["技能"], result: ["结算"] }, fallbackPoolId: "fallback", rules: [
  { id: "active", poolId: "ability", on: [{ type: "core.ability-played", apiVersion: 1 }], when: { primitive: "core.event-ability-id", apiVersion: 1, args: {}, test: { eq: "neutral-active" } }, portrait: { image: "ability.png" } },
  { id: "action", poolId: "action", on: [{ type: "core.action", apiVersion: 1 }], when: { primitive: "core.event-actor", apiVersion: 1, args: {}, test: { eq: "player" } }, portrait: { image: "action.png" } },
  { id: "result", poolId: "result", on: [{ type: "core.round-result", apiVersion: 1 }], when: { primitive: "core.round-reason", apiVersion: 1, args: {}, test: { eq: "comparison" } } }
] };

it("emits successful active/automatic occurrences with stable identities, never failures or redraws", () => {
  const before = base(), after = append(before, [played, triggered]);
  const events = extractDialogueEvents(before, after);
  expect(events.map(e => e.type)).toEqual(["core.ability-triggered", "core.ability-played"]);
  expect(events[0].data).toEqual({ actor: "opponent", definitionId: "neutral-passive", instanceId: "passive", ruleId: "on-acquire" });
  expect(events[1].data).toEqual({ actor: "player", definitionId: "neutral-active", instanceId: "active-card" });
  expect(extractDialogueEvents(before, after)).toEqual(events);
  expect(extractDialogueEvents(after, { ...after })).toEqual([]);
  expect(extractDialogueEvents(after, after)).toEqual([]);
  expect(extractDialogueEvents(before, append(before, [{ type: "ABILITY_RESOLUTION_FAILED", definitionId: "neutral-active", instanceId: "active-card", ruleId: "play", reason: "unavailable" }]))).toEqual([]);
  expect(extractDialogueEvents(undefined, after)).toEqual([restoreDialogueEvent(after)]);
});
it("keeps ordinary events, puts ability responses after actions, and gives final results priority", () => {
  const before = base();
  expect(extractDialogueEvents(before, append(before, [played, triggered, { type: "PLAYER_HIT", value: 14 }])).map(e => e.type)).toEqual(["core.action", "core.ability-triggered", "core.ability-played"]);
  const outcome = { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } as const;
  const after = { ...append(before, [played, { type: "ROUND_RESOLVED", outcome }]), round: { ...before.round, phase: "round-reveal" as const, outcome } };
  expect(extractDialogueEvents(before, after).map(e => e.type)).toEqual(["core.ability-played", "core.round-result"]);
  const next = { ...append(before, [played, { type: "ROUND_STARTED", roundIndex: 1 }, triggered]), roundIndex: 1 };
  expect(extractDialogueEvents(before, next).map(e => e.type)).toEqual(["core.round-start", "core.ability-triggered"]);
});
it("queries ability identity and per-round successful plays without treating passive triggers as plays", () => {
  const before = base(), state = append(before, [played, triggered, played]);
  const event = extractDialogueEvents(before, state)[0];
  expect(read("event-ability-id", { state, event })).toBe("neutral-passive");
  expect(read("event-ability-rule-id", { state, event })).toBe("on-acquire");
  expect(read("event-ability-rule-id", { state, event: extractDialogueEvents(before, state).at(-1)! })).toBeNull();
  expect(read("event-ability-id", { state, event: restoreDialogueEvent(state) })).toBeNull();
  expect(read("event-ability-id", { state })).toBeUndefined();
  expect(read("ability-play-count", { state }, { actor: "player" })).toBe(2);
  expect(read("ability-play-count", { state }, { actor: "player", definitionId: "neutral-active" })).toBe(2);
  expect(read("ability-play-count", { state }, { actor: "opponent" })).toBe(0);
  const next = append(state, [{ type: "ROUND_STARTED", roundIndex: 1 }]);
  expect(read("ability-play-count", { state: next }, { actor: "player", definitionId: "neutral-active" })).toBe(0);
});
it("atomically resolves a batch's images and keeps the action when no ability rule matches", async () => {
  const before = base(), after = append(before, [{ type: "PLAYER_HIT", value: 14 }, played, triggered]);
  const changed = vi.fn();
  const session = new DialogueSession(new DialogueEngine(program, "neutral"), before, new PresentationStore(new MemoryPresentationDriver()), async () => true, changed);
  await session.start([], false); session.transition(after);
  await vi.waitFor(() => expect(session.peek().line).toBe("技能"));
  expect(changed).toHaveBeenCalledTimes(2); // initial fallback and one completed transition
  session.transition(append(after, [{ type: "PLAYER_HIT", value: 16 }, { ...played, definitionId: "other" }]));
  await vi.waitFor(() => expect(session.peek().line).toBe("行动"));
  await session.dispose();
});
it("discards a pending ability image if a newer transition or disposal supersedes it", async () => {
  const before = base(); let finish!: (ok: boolean) => void;
  const session = new DialogueSession(new DialogueEngine(program, "neutral"), before, new PresentationStore(new MemoryPresentationDriver()), () => new Promise(resolve => finish = resolve));
  await session.start([], false); session.transition(append(before, [played]));
  const outcome = { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } as const;
  const after = { ...append(before, [played, { type: "ROUND_RESOLVED", outcome }]), round: { ...before.round, phase: "round-reveal" as const, outcome } };
  session.transition(after); expect(session.peek().line).toBe("结算");
  finish(true); await Promise.resolve(); expect(session.peek().line).toBe("结算");
  await session.dispose();
});
