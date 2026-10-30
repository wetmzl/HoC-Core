import { describe, expect, it } from "vitest";
import { createCard, cardRank, cardSuit } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { applyEffects } from "./effects";
import { AbilityDefinitionSchema } from "./schema";
import { resolveAbilityEvent } from "./engine";
import { createAbilityRuntime, addAbilityInstance } from "./runtime";
import { createStandaloneAbilityRegistry } from "./registry";
import type { AbilityInstance, AbilityWorld, Effect } from "./types";

const skill = { id: "neutral-declarative", name: "Neutral", description: "Neutral operations", sourceKind: "player-skill", primaryDomain: "gambler", tags: ["neutral"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
  activation: { type: "action", windows: ["owner-turn"], consume: "card" }, rules: [{ id: "play", trigger: "on-ability-played", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }] };
function fixture() {
  const rng = new SeededRng("declarative-primitives");
  const registry = createStandaloneAbilityRegistry([skill, { ...skill, id: "neutral-gift", acquisitionLimit: { perMatch: 1 } }], [{ id: "neutral-state", defaultDuration: "match", rules: [] }]);
  const ability: AbilityInstance = { definitionId: skill.id, instanceId: "source", kind: "player-skill", owner: "player", parameters: {}, createdAtSequence: 1 };
  const world: AbilityWorld = { hands: { player: { cards: [createCard("hearts", "4", "one"), createCard("clubs", "6", "two")] }, opponent: { cards: [createCard("diamonds", "8", "rival")] } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [createCard("spades", "9", "draw")], cursor: 0, shuffleIndex: 0 }, statuses: [], cards: [], skillDraws: 0 };
  return { rng, registry, ability, world, runtime: createAbilityRuntime(rng.snapshot()), event: { trigger: "on-ability-played" as const, sourceEventId: "play" } };
}
describe("declarative operation policies", () => {
  it("assigns typed observations to arbitrary keys while preserving unrelated status data and provenance", () => {
    const f = fixture();
    const previous = { owner: "player" as const, statusDefinitionId: "neutral-state", sourceInstanceId: "old-source", stacks: 3, duration: "match" as const, createdAtSequence: 4, parameters: { untouched: 7 } };
    const result = applyEffects([{ type: "assign-status-values", target: "owner", statusDefinitionId: "neutral-state", values: {
      rememberedFace: { type: "card-attribute", target: "rival", card: "last-card", attribute: "rank" },
      selectedSuit: { type: "hand-dominant-suit", target: "owner", tieBreak: ["clubs", "diamonds", "hearts", "spades"] }
    } }], { ...f, world: { ...f.world, statuses: [previous] } });
    expect(result.world.statuses[0]).toEqual({ ...previous, parameters: { untouched: 7, rememberedFace: "8", selectedSuit: "clubs" } });
    expect(f.rng.snapshot()).toEqual(f.runtime.rng);
  });
  it("transforms a selected non-last card into three source-suit cards without touching the physical ledger", () => {
    const f = fixture();
    const effect: Effect = { type: "transform-hand-card", target: "owner", card: "first-public-card", output: { count: 3, total: 12, suits: "source-suit" } };
    const result = applyEffects([effect], f);
    const cards = result.world.hands.player.cards;
    expect(cards).toHaveLength(4); expect(cards.at(-1)?.id).toBe("two");
    expect(cards.slice(0, 3).every(card => cardSuit(card) === "hearts" && card.attributes.source === "derived")).toBe(true);
    expect(cards.slice(0, 3).reduce((sum, card) => sum + Number(cardRank(card)), 0)).toBe(12);
    expect(new Set(cards.map(card => card.id)).size).toBe(4);
    expect(result.world.shoe).toBe(f.world.shoe);
    expect(result.acquiredCards).toHaveLength(3);
  });
  it("tries ordered acquisition choices without sampling an empty set and can choose a physical card without consuming RNG", () => {
    const f = fixture(); const before = f.rng.snapshot();
    const result = applyEffects([{ type: "acquire-card", target: "owner", choices: [
      { source: "derived", candidate: { type: "resulting-hand-total-exactly", value: 100 }, pick: "uniform-ability-rng" },
      { source: "draw-pile", pick: "first" }
    ] }], f);
    expect(result.world.hands.player.cards.at(-1)?.id).toBe("draw");
    expect(result.world.shoe.cursor).toBe(1); expect(f.rng.snapshot()).toEqual(before);
  });
  it("grants an explicitly selected skill and enforces its acquisition budget", () => {
    const f = fixture();
    const effects: Effect[] = [{ type: "grant-skill-card", target: "owner", choices: [{ type: "last-successful-player-skill" }, { type: "definition", definitionId: "neutral-gift" }] }];
    const first = applyEffects(effects, f);
    expect(first.world.cards[0].definitionId).toBe("neutral-gift");
    expect(() => applyEffects(effects, { ...f, world: first.world, runtime: first.runtime })).toThrow();
    expect(first.world.cards).toHaveLength(1);
  });
  it.each([true, false])("can grant a passive skill with explicit acquisition initialization=%s", initialize => {
    const f = fixture();
    const passive = { ...skill, id: "neutral-passive", activation: { type: "passive" }, ttl: { type: "triggers", amount: 3 },
      rules: [{ id: "gained", trigger: "on-ability-gained", effects: [{ type: "add-skill-draws", target: "owner", amount: 2 }] }] };
    const giver = { ...skill, id: "neutral-giver", rules: [{ id: "give", trigger: "on-ability-played", effects: [{ type: "grant-skill-card", target: "owner", initialize, choices: [{ type: "definition", definitionId: passive.id }] }] }] };
    const registry = createStandaloneAbilityRegistry([passive, giver], []);
    const instance = { ...f.ability, definitionId: giver.id };
    const runtime = addAbilityInstance(f.runtime, instance, registry);
    const result = resolveAbilityEvent({ ...f, registry, runtime, directInstanceId: instance.instanceId });
    expect(result.world.skillDraws).toBe(initialize ? 2 : 0);
    expect(result.world.cards[0].definitionId).toBe(passive.id);
    expect(result.runtime.instances.find(instance => instance.definitionId === passive.id)?.ttl?.remaining).toBe(initialize ? 2 : 3);
    expect(() => resolveAbilityEvent({ ...f, registry, world: result.world, runtime: result.runtime, directInstanceId: instance.instanceId, event: { ...f.event, sourceEventId: "again" } })).toThrow("non-stackable");
  });
  it("rejects duplicate suit precedence, empty assignments and unbounded transformations", () => {
    for (const effects of [
      [{ type: "assign-status-values", target: "owner", statusDefinitionId: "neutral-state", values: {} }],
      [{ type: "assign-status-values", target: "owner", statusDefinitionId: "neutral-state", values: { suit: { type: "hand-dominant-suit", target: "owner", tieBreak: ["clubs", "clubs", "hearts", "spades"] } } }],
      [{ type: "transform-hand-card", target: "owner", card: "last-card", output: { count: 1000, total: 12, suits: "same-color" } }]
    ]) expect(AbilityDefinitionSchema.safeParse({ ...skill, rules: [{ ...skill.rules[0], effects }] }).success).toBe(false);
  });
});
