import { describe, expect, it } from "vitest";
import { capturePlayerSkills } from "../abilities/carryover";
import { DEFAULT_AI_PROFILE } from "../ai/types";
import { createMatch } from "../match/reducer";
import { INITIAL_PLAYER_SKILL_IDS, getPlayerSkillDefinition } from "../skills/definitions";
import { MatchInitSpecSchema, resolveMatchInit, type MatchInitInput } from "./initialization";

function input(): MatchInitInput {
  return { id: "visit-1", seed: "init-seed", opponentId: "llama",
    resources: { gun: { capacity: 8, bullets: 2 }, player: null, comparisonBonus: 3 },
    context: { character: { ai: DEFAULT_AI_PROFILE, aiSkills: [] }, profile: {
      unlockedPlayerSkillIds: INITIAL_PLAYER_SKILL_IDS, skillDeckIds: INITIAL_PLAYER_SKILL_IDS,
      talentIds: [], intrinsicAbilities: [], autoSkipAfterStand: false
    } } };
}
const activeId = () => INITIAL_PLAYER_SKILL_IDS.find(id => getPlayerSkillDefinition(id)?.category === "active")!;

describe("declarative match initialization", () => {
  it("resolves node overrides before dealing and permits a fixed pool independent of the profile deck gate", () => {
    const base = input();
    const brokenProfile = { ...base.context, profile: { ...base.context.profile, skillDeckIds: [] } };
    expect(() => resolveMatchInit({ ...base, context: brokenProfile })).toThrow("还需加入");
    const plan = resolveMatchInit({ ...base, context: brokenProfile,
      defaults: { playerGun: { mode: "reset" }, comparisonBonuses: { player: 9, opponent: -2 } },
      init: { playerGun: { mode: "replace", value: { capacity: 3, bullets: 1 } },
        opponentGun: { mode: "replace", value: { capacity: 7, bullets: 4 } },
        comparisonBonuses: { player: -1 }, skillPool: { source: "fixed", ids: [activeId()] },
        playerSkills: { mode: "reset", openingCards: 0, draws: 4 } } });
    const match = createMatch(plan.seed, plan.options);
    expect(match.id).toBe("visit-1");
    expect(match.roulette).toEqual({ player: { capacity: 3, bullets: 1 }, opponent: { capacity: 7, bullets: 4 } });
    expect(match.comparisonBonuses).toEqual({ player: -1, opponent: -2 });
    expect(match.playerSkills.cards).toHaveLength(0);
    expect(match.playerSkills.drawCount).toBe(4);
    expect(match.playerSkills.deckDefinitionIds).toEqual([activeId()]);
    expect(match.player.hand.cards).toHaveLength(2);
    expect(match.autoSkipAfterStand).toBe(false);
  });

  it("replaces initial inventory with authored bindings and no random opening grants", () => {
    const plan = resolveMatchInit({ ...input(), init: { playerSkills: { mode: "replace", cards: [
      { definitionId: activeId(), enabled: true, parameters: {} }
    ], draws: 2 } } });
    const match = createMatch(plan.seed, plan.options);
    expect(match.playerSkills.cards.map(card => card.definitionId)).toEqual([activeId()]);
    expect(match.playerSkills.acquisitionCounts?.[activeId()]).toBe(1);
    expect(match.playerSkills.drawCount).toBe(2);
    expect(match.abilities.instances.some(instance => instance.instanceId === match.playerSkills.cards[0].instanceId)).toBe(true);
  });

  it("preserves empty initialized inventory, acquisition budgets, counters and RNG across tables", () => {
    const base = input();
    const firstPlan = resolveMatchInit({ ...base, init: { playerSkills: { mode: "reset", openingCards: 0, draws: 0 } } });
    const first = createMatch(firstPlan.seed, firstPlan.options);
    const carryover = capturePlayerSkills(first);
    const stored = { ...carryover, inventory: { ...carryover.inventory, acquisitionCounts: { [activeId()]: 1 } } };
    const nextPlan = resolveMatchInit({ ...base, id: "visit-2", seed: "different", resources: { ...base.resources, player: stored },
      init: { playerSkills: { mode: "inherit" } } });
    expect(nextPlan.options.grantOpeningSkills).toBe(false);
    const next = createMatch(nextPlan.seed, nextPlan.options);
    expect(next.playerSkills.cards).toEqual([]);
    expect(next.playerSkills.drawCount).toBe(0);
    expect(next.playerSkills.acquisitionCounts).toEqual(stored.inventory.acquisitionCounts);
    expect(next.rng.loot).toEqual(stored.lootRng);
    expect(next.abilities.rng).toEqual(stored.rng);
    const reset = resolveMatchInit({ ...base, resources: { ...base.resources, player: stored }, init: { playerSkills: { mode: "reset" } } });
    expect(reset.options.playerCarryover).toBeUndefined();
    expect(reset.options.grantOpeningSkills).toBe(true);
  });

  it("combines plugin defaults with authored intrinsic bindings and validates fixed resources", () => {
    const base = input();
    const binding = { definitionId: "builtin-debug-control", enabled: true, parameters: {} };
    const plan = resolveMatchInit({ ...base, context: { ...base.context, profile: { ...base.context.profile, intrinsicAbilities: [binding] } },
      init: { intrinsicAbilities: [{ ...binding, parameters: { bustBonus: 2 } }] } });
    expect(plan.options.intrinsicAbilities).toHaveLength(1);
    const match = createMatch(plan.seed, plan.options);
    expect(match.abilities.instances.find(instance => instance.intrinsic)?.parameters.bustBonus).toBe(2);
    expect(() => resolveMatchInit({ ...base, init: { skillPool: { source: "fixed", ids: ["missing"] } } })).toThrow("技能池");
    expect(() => resolveMatchInit({ ...base, init: { opponentAbilities: [{ definitionId: activeId(), enabled: true, parameters: {} }] } })).toThrow("能力类型");
    expect(MatchInitSpecSchema.safeParse({ playerSkills: { mode: "replace" } }).success).toBe(false);
    expect(MatchInitSpecSchema.safeParse({ playerGun: { mode: "replace", value: { capacity: 3, bullets: 4 } } }).success).toBe(false);
  });
});
