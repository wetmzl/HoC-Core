import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { PlayerSkillAbilityDefinition, StatusDefinition } from "../abilities/types";
import { createCard } from "../blackjack/card";
import { createMatch, gameReducer, getActiveBustLimit } from "./reducer";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));

describe("ability services use the current transaction runtime", () => {
  it("keeps a newly granted status source when computing a limit and Hit forecast", () => {
    const granted: PlayerSkillAbilityDefinition = {
      id: "example-granted-limit", name: "新获得的上限", description: "中性事务来源夹具", sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["example"],
      drop: { enabled: true, baseWeight: 1 }, stackable: false, activation: { type: "passive" }, ttl: { type: "rounds", amount: 1 },
      rules: [{ id: "initialize-current-source", trigger: "on-ability-gained", effects: [
        { type: "add-status", target: "owner", statusDefinitionId: "example-raised-limit" },
        { type: "assign-status-values", target: "owner", statusDefinitionId: "example-observed-limit", values: { ["limit"]: { type: "numeric", value: { type: "bust-limit", target: "owner" } } } },
        { type: "publish-hit-bust-forecast", target: "owner" }
      ] }]
    };
    const donor: PlayerSkillAbilityDefinition = {
      id: "example-grant-action", name: "授予", description: "中性授予夹具", sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["example"],
      drop: { enabled: true, baseWeight: 1 }, stackable: false, activation: { type: "action", windows: ["owner-turn"], consume: "card" },
      rules: [{ id: "grant", trigger: "on-ability-played", effects: [{ type: "grant-skill-card", target: "owner", choices: [{ type: "definition", definitionId: granted.id }] }] }]
    };
    const statuses: readonly StatusDefinition[] = [
      { id: "example-raised-limit", defaultDuration: "round", rules: [{ id: "raise-limit", trigger: "before-bust-check", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 4 }] }] },
      { id: "example-observed-limit", defaultDuration: "round", rules: [] }
    ];
    installAbilityRegistry([...original.definitions, donor, granted], [...original.statuses, ...statuses], original.catalogVersion);
    const base = createMatch("current-runtime-services", { opponentId: "chatgpt", grantOpeningSkills: false, skillDeckIds: [], initialPlayerSkills: [{ definitionId: donor.id, enabled: true, parameters: {} }] });
    const player = { ...base.player, hand: { cards: [createCard("clubs", "10", "player-ten"), createCard("hearts", "10", "player-other-ten")] }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: [createCard("spades", "10", "opponent-ten"), createCard("diamonds", "8", "opponent-eight")] }, stood: false, busted: false, bustLimit: undefined };
    const used = [...player.hand.cards, ...opponent.hand.cards];
    const state = { ...base, player, opponent, playerSkills: { ...base.playerSkills, drawOffer: null }, shoe: { cards: [...used, createCard("hearts", "4", "forecast-card")], cursor: used.length, shuffleIndex: 1 },
      round: { ...base.round, player, opponent, phase: "turns" as const, currentActor: "player" as const, outcome: null }
    };
    const next = gameReducer(state, { type: "PLAY_ABILITY", instanceId: state.playerSkills.cards[0]!.instanceId });
    expect(next.abilities.statuses.find(status => status.statusDefinitionId === "example-observed-limit")?.parameters.limit).toBe(25);
    expect(next.history).toContainEqual(expect.objectContaining({ type: "ABILITY_RESULT", definitionId: granted.id, result: { type: "hit-bust-forecast", actor: "player", wouldBust: false } }));
    expect(next.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    expect(getActiveBustLimit(next, "player")).toBe(25);
    expect(getActiveBustLimit(next, "opponent")).toBe(21);
    const source = next.abilities.statuses.find(status => status.statusDefinitionId === "example-raised-limit")!.sourceInstanceId;
    expect(next.abilities.instances).toContainEqual(expect.objectContaining({ instanceId: source, definitionId: granted.id }));
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(next)))).activeMatch!;
    expect(getActiveBustLimit(restored, "player")).toBe(25);
    expect(state.abilities.statuses).toEqual([]);
  });
});
