import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import { createCard } from "../blackjack/card";
import { createMatch, gameReducer, getLegalActions } from "./reducer";
import type { Actor, MatchState } from "./types";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));
function fixture(actor: Actor = "player"): MatchState {
  installAbilityRegistry([...registry.definitions, {
    id: "example-active-pass", name: "Pass", description: "Yield current turn", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["turn-control"],
    activation: { type: "action", windows: ["owner-turn"], consume: "none", availability: [{ type: "pending-turn-can-skip", target: "owner" }] },
    rules: [{ id: "pass", trigger: "on-ability-played", effects: [{ type: "skip-turn", target: "owner" }] }]
  }], registry.statuses, registry.catalogVersion);
  const binding = [{ definitionId: "example-active-pass", enabled: true, parameters: {} }];
  const base = createMatch("active-pass", { opponentId: "chatgpt", playerAiSkills: actor === "player" ? binding : [], opponentAiSkills: actor === "opponent" ? binding : [] });
  const player = { ...base.player, hand: { cards: [createCard("clubs", "2", "p1"), createCard("hearts", "3", "p2")] }, stood: false, busted: false };
  const opponent = { ...base.opponent, hand: { cards: [createCard("spades", "2", "o1"), createCard("diamonds", "3", "o2")] }, stood: false, busted: false };
  return { ...base, player, opponent, round: { ...base.round, phase: "turns", currentActor: actor, outcome: null, player, opponent } };
}
function action(state: MatchState) { return { type: "PLAY_ABILITY" as const, instanceId: state.abilities.instances.find(i => i.definitionId === "example-active-pass")!.instanceId }; }
describe("active turn passes", () => {
  it.each(["player", "opponent"] as const)("hands off %s without Hit or Stand or changing cards", actor => {
    const state = fixture(actor); const before = structuredClone(state);
    expect(getLegalActions(state)).toContainEqual(action(state)); expect(state).toEqual(before);
    const next = gameReducer(state, action(state));
    expect(next.round.currentActor).toBe(actor === "player" ? "opponent" : "player");
    expect(next.player).toEqual(state.player); expect(next.opponent).toEqual(state.opponent); expect(next.shoe).toEqual(state.shoe);
    expect(next.history.slice(state.history.length)).toContainEqual({ type: "TURN_SKIPPED", actor, sourceInstanceId: action(state).instanceId });
  });
  it("rejects unavailable handoff atomically", () => {
    const base = fixture(); const opponent = { ...base.opponent, stood: true };
    const state = { ...base, opponent, round: { ...base.round, opponent } };
    expect(getLegalActions(state)).not.toContainEqual(action(state)); expect(gameReducer(state, action(state))).toBe(state);
  });
  it("can hand off to a stood player when optional post-Stand turns are enabled", () => {
    const base = fixture("opponent"); const player = { ...base.player, stood: true };
    const state = { ...base, autoSkipAfterStand: false, player, round: { ...base.round, player } };
    const next = gameReducer(state, action(state)); expect(next.round.currentActor).toBe("player"); expect(next.player.stood).toBe(true);
  });
});
