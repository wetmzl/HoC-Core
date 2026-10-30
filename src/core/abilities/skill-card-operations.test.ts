import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { resolveScalar } from "./conditions";
import { resolveDisplays, displaySkillCardMarkers } from "./displays";
import { abilityWorld, createMatch, gameReducer } from "../match/reducer";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { resolveAbilityEvent } from "./engine";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import { AbilityDefinitionSchema, AbilityDisplaySchema, AbilityRuleSchema, SkillCardFilterSchema } from "./schema";
import { selectSkillCards } from "./skill-card-selection";
import type { Rank } from "../blackjack/types";
import type { AbilityRule, AbilityWorld, PlayerSkillAbilityDefinition, SkillCardInstance, SkillCardFilter } from "./types";

const playerSkill = (id: string, passive = false): PlayerSkillAbilityDefinition => ({
  id, name: id, description: "Neutral inventory fixture", sourceKind: "player-skill", primaryDomain: "gambler",
  skillTags: ["gambler", "cheater"], tags: ["neutral", passive ? "duration" : "action"],
  activation: passive ? { type: "passive" } : { type: "action", consume: "card", windows: ["owner-turn"], uses: 3 },
  ...(passive ? { ttl: { type: "rounds", amount: 4 } as const } : {}),
  rules: passive ? [{ id: "late", trigger: "before-turn", priority: 10, effects: [{ type: "add-gun-bullets", target: "owner", amount: 5 }] }] : [],
  drop: { enabled: true, baseWeight: 1 }, stackable: false, acquisitionLimit: { perMatch: 2 }
});
const active = playerSkill("neutral-active"), passive = playerSkill("neutral-passive", true);
const readout = { id: "neutral-counter", defaultDuration: "match" as const, rules: [] };
const removal: AbilityRule = { id: "remove", trigger: "before-turn", effects: [
  { type: "remove-skill-cards", target: "rival", filter: { primaryDomains: ["gambler"] }, resultKey: "removed" },
  { type: "assign-status-values", target: "owner", statusDefinitionId: readout.id, values: { ["count"]: { type: "numeric", value: { type: "effect-result", key: "removed" } } } }
] };
function fixture(rules: readonly AbilityRule[] = [removal]) {
  const controller = { id: "neutral-controller", name: "Controller", description: "Neutral card operations", sourceKind: "ai-skill", primaryDomain: "intelligence-officer", tags: ["neutral"], activation: { type: "automatic" }, rules };
  const registry = createStandaloneAbilityRegistry([controller, active, passive], [readout, { id: "neutral-buff", defaultDuration: "match", rules: [{ id: "late-buff", trigger: "before-turn", priority: 20, effects: [{ type: "add-gun-bullets", target: "status-owner", amount: 3 }] }] }]);
  const sources = [[controller.id, "opponent", "controller", "ai-skill"], [active.id, "player", "card", "player-skill"], [passive.id, "player", "card:long", "player-skill"], [active.id, "player", "kept", "player-skill"]] as const;
  let runtime = createAbilityRuntime(new SeededRng("neutral-inventory").snapshot());
  for (const [id, owner, instanceId, kind] of sources) runtime = addAbilityInstance(runtime, instantiateAbility({ definitionId: id, enabled: true, parameters: {} }, owner, instanceId, runtime.sequence + 1, registry, kind), registry);
  runtime = { ...runtime, counters: { "card:x:match": 1, "card:long:y:round": 2, "kept:z:turn": 3 }, statuses: [{ statusDefinitionId: "neutral-buff", owner: "player", sourceInstanceId: "card:long", createdAtSequence: 5, duration: "match", stacks: 1, parameters: {} }] };
  const cards: SkillCardInstance[] = sources.slice(1).map(([definitionId, owner, instanceId]) => ({ definitionId, owner, instanceId, kind: "player-skill", level: 1 }));
  const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [createCard("spades", "2", "public"), createCard("hearts", "3", "hidden"), createCard("hearts", "4", "revealed")] } }, publicCardIds: ["revealed"],
    cards, statuses: runtime.statuses, skillAcquisitionCounts: { [active.id]: 2, [passive.id]: 1 }, skillDraws: 0,
    guns: { player: { capacity: 8, bullets: 0 }, opponent: { capacity: 8, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 } };
  return { world, runtime, registry, event: { trigger: "before-turn" as const, sourceEventId: "turn-1" }, controller };
}
const ids = (cards: readonly SkillCardInstance[]) => cards.map(card => card.instanceId);

describe("generic skill inventory operations", () => {
  it("shares deterministic intersection/alternative filters across count, effects and markers", () => {
    const input = fixture();
    const queries: [SkillCardFilter, string[]][] = [
      [{}, ["card", "card:long", "kept"]], [{ instanceIds: ["card", "kept"] }, ["card", "kept"]],
      [{ definitionIds: [passive.id] }, ["card:long"]], [{ primaryDomains: ["gambler", "gunslinger"] }, ["card", "card:long", "kept"]],
      [{ primaryDomains: ["cheater"] }, []], [{ skillTags: ["cheater"], activation: "passive" }, ["card:long"]],
      [{ tags: ["duration", "unknown"], primaryDomains: ["gambler"] }, ["card:long"]], [{ tags: ["duration"], activation: "action" }, []]
    ];
    const ability = input.runtime.instances[0];
    for (const [filter, expected] of queries) {
      expect(ids(selectSkillCards(input.world, "player", filter, input.registry))).toEqual(expected);
      expect(resolveScalar({ type: "skill-card-count", target: "rival", filter }, { ...input, ability })).toBe(expected.length);
    }
    expect(selectSkillCards(input.world, "opponent", {}, input.registry)).toEqual([]);
    expect(input.runtime.rng).toEqual(fixture().runtime.rng);
  });

  it("counts actual public suits without treating private knowledge as public", () => {
    const input = fixture(), context = { ...input, ability: input.runtime.instances[0] };
    expect(resolveScalar({ type: "public-hand-card-suit-count", target: "owner", suit: "spades" }, context)).toBe(1);
    expect(resolveScalar({ type: "public-hand-card-suit-count", target: "owner", suit: "hearts" }, context)).toBe(1);
    expect(resolveScalar({ type: "public-hand-card-suit-count", target: "owner", suit: "clubs" }, context)).toBe(0);
  });

  it("removes every selected instance, cancels queued passive/status rules, and preserves budgets", () => {
    const input = fixture(), result = resolveAbilityEvent(input);
    expect(result.world.cards).toEqual([]);
    expect(result.runtime.instances.map(instance => instance.instanceId)).toEqual(["controller"]);
    expect(result.runtime.counters).toEqual({});
    expect(result.world.statuses).toHaveLength(1);
    expect(result.world.statuses[0]).toMatchObject({ owner: "opponent", statusDefinitionId: readout.id, parameters: { count: 3 } });
    expect(result.world.skillAcquisitionCounts).toEqual(input.world.skillAcquisitionCounts);
    expect(result.world.guns.player.bullets).toBe(0);
    expect(result.triggered).toEqual(["controller:remove"]);
    expect(result.events).toContainEqual({ type: "SKILL_CARDS_REMOVED", actor: "player", sourceInstanceId: "controller", cards: input.world.cards });
    const again = resolveAbilityEvent({ ...input, world: result.world, runtime: result.runtime, event: { ...input.event, sourceEventId: "turn-2" } });
    expect(again.world.statuses[0].parameters.count).toBe(0);
    expect(again.events.some(event => event.type === "SKILL_CARDS_REMOVED")).toBe(false);
  });

  it("prunes counters for exact source identities, retaining a longer unrelated identity", () => {
    const input = fixture([{ ...removal, effects: [{ type: "remove-skill-cards", target: "rival", filter: { instanceIds: ["card"] } }] }]);
    const result = resolveAbilityEvent(input);
    expect(ids(result.world.cards)).toEqual(["card:long", "kept"]);
    expect(result.runtime.counters).toEqual({ "card:long:y:round": 2, "kept:z:turn": 3 });
    expect(result.world.guns.player.bullets).toBe(8);
  });

  it("returns zero for overlapping second removals within the same transaction", () => {
    const input = fixture([{ ...removal, effects: [
      { type: "remove-skill-cards", target: "rival", resultKey: "first" },
      { type: "remove-skill-cards", target: "rival", resultKey: "second" },
      { type: "assign-status-values", target: "owner", statusDefinitionId: readout.id, values: { ["count"]: { type: "numeric", value: { type: "add", left: { type: "effect-result", key: "first" }, right: { type: "effect-result", key: "second" } } } } }
    ] }]);
    const result = resolveAbilityEvent(input);
    expect(result.world.statuses[0].parameters.count).toBe(3);
    expect(result.events.filter(event => event.type === "SKILL_CARDS_REMOVED")).toHaveLength(1);
  });

  it("rolls back removal, counters, statuses and rewards if a later effect fails", () => {
    const input = fixture([{ ...removal, limit: { perMatch: 1 }, effects: [...removal.effects, { type: "add-to-pending-comparison-score", target: "owner", amount: 1 }] }]);
    const snapshot = structuredClone(input.world), runtime = structuredClone(input.runtime);
    expect(() => resolveAbilityEvent(input)).toThrow("outside comparison resolution");
    expect(input.world).toEqual(snapshot); expect(input.runtime).toEqual(runtime);
  });

  it("allows self-removal without leaving a queued rule or counter alive", () => {
    const input = fixture(), self = { ...passive, rules: [{ id: "self-remove", trigger: "before-turn", limit: { perMatch: 1 }, effects: [{ type: "remove-skill-cards", target: "owner" }] }, ...passive.rules] };
    const registry = createStandaloneAbilityRegistry([input.controller, active, self], [readout, { id: "neutral-buff", defaultDuration: "match", rules: [] }]);
    const result = resolveAbilityEvent({ ...input, registry, owners: ["player"] });
    expect(result.world.cards).toEqual([]); expect(result.runtime.counters).toEqual({});
    expect(result.runtime.instances.map(instance => instance.instanceId)).toEqual(["controller"]);
    expect(result.triggered).toEqual(["card:long:self-remove"]);
    const invalidSelf = { ...self, rules: [{ ...self.rules[0], effects: [...self.rules[0].effects, { type: "assign-status-values", target: "owner", statusDefinitionId: readout.id, values: { ["count"]: { type: "numeric", value: 1 } } }] }] };
    const invalidRegistry = createStandaloneAbilityRegistry([input.controller, active, invalidSelf], [readout, { id: "neutral-buff", defaultDuration: "match", rules: [] }]);
    expect(() => resolveAbilityEvent({ ...input, registry: invalidRegistry, owners: ["player"] })).toThrow("removed ability cannot create");
  });

  it("persists removal history and budgets through an actual round transition", () => {
    const original = ABILITY_REGISTRY;
    const controller = { ...fixture().controller, rules: [{ ...removal, trigger: "on-round-end" as const }] };
    try {
      installAbilityRegistry([...original.definitions, controller, active, passive], [...original.statuses, readout], original.catalogVersion);
      const base = createMatch("neutral-inventory-save", { opponentId: "claude", skillDeckIds: [], unlockedPlayerSkillIds: [active.id, passive.id], opponentAiSkills: [{ definitionId: controller.id, enabled: true, parameters: {} }] });
      let runtime = base.abilities;
      const cards: SkillCardInstance[] = [];
      for (const [index, definition] of [active, passive].entries()) {
        const instanceId = `inventory-${index}`;
        runtime = addAbilityInstance(runtime, instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", instanceId, runtime.sequence + 1));
        cards.push({ definitionId: definition.id, kind: "player-skill", owner: "player", instanceId, level: 1 });
      }
      const state = { ...base, abilities: runtime, playerSkills: { ...base.playerSkills, cards, acquisitionCounts: { [active.id]: 1, [passive.id]: 1 } }, round: { ...base.round, phase: "round-reveal" as const, currentActor: null, outcome: { reason: "push" as const, winner: null, penaltyTarget: null, bulletsAdded: 0 } } };
      const after = gameReducer(state, { type: "ACK_ROUND_RESULT" });
      const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(after)))).activeMatch!;
      expect(restored.playerSkills.cards).toEqual([]);
      expect(restored.playerSkills.acquisitionCounts).toEqual(state.playerSkills.acquisitionCounts);
      expect(restored.history.filter(event => event.type === "SKILL_CARDS_REMOVED")).toHaveLength(1);
      expect(abilityWorld(restored).statuses.find(status => status.statusDefinitionId === readout.id)?.parameters.count).toBe(2);
      expect(gameReducer(state, { type: "ACK_ROUND_RESULT" })).toEqual(after);
      const malformed = JSON.parse(JSON.stringify(createRuntimeSave(after)));
      const removed = malformed.activeMatch.history.find((event: { type: string }) => event.type === "SKILL_CARDS_REMOVED");
      removed.cards.push(removed.cards[0]);
      expect(() => validateRuntimeSave(malformed)).toThrow();
    } finally { installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion); }
  });

  it("projects multiple deduplicated instance markers and gates them on stable facts", () => {
    const input = fixture();
    const declaration = { id: "markers", target: "owner" as const, description: "Inventory markers", content: [{ type: "text" as const, text: "Inventory" }], skillCardMarkers: [
      { targets: ["rival" as const], filter: { primaryDomains: ["gambler" as const] }, active: { type: "public-hand-card-suit-count" as const, target: "owner" as const, suit: "spades" as const }, type: "selected", label: "Selected" },
      { targets: ["rival" as const], filter: { activation: "passive" as const }, type: "duration", label: "Duration" },
      { targets: ["rival" as const], filter: { activation: "passive" as const }, type: "duration", label: "Duration" },
      { targets: ["rival" as const], filter: { activation: "passive" as const }, type: "selected", label: "Selected", appearance: "purple-glow" as const },
      { targets: ["rival" as const], active: 0, type: "off", label: "Off" }
    ] };
    const definition = { ...input.controller, displays: [declaration] };
    const registry = createStandaloneAbilityRegistry([definition, active, passive], [readout]);
    let runtime = createAbilityRuntime(input.runtime.rng);
    runtime = addAbilityInstance(runtime, input.runtime.instances[0], registry);
    const markers = displaySkillCardMarkers(resolveDisplays(runtime, input.world, registry));
    expect(markers["card:long"]).toEqual([{ type: "selected", label: "Selected" }, { type: "duration", label: "Duration" }, { type: "selected", label: "Selected", appearance: "purple-glow" }]);
    expect(markers.card).toEqual([{ type: "selected", label: "Selected" }]);
    expect(displaySkillCardMarkers(resolveDisplays(runtime, { ...input.world, cards: [] }, registry))).toEqual({});
  });

  it("rejects invalid filters, unresolved references and transient display/activation queries", () => {
    for (const filter of [{ tags: [] }, { primaryDomains: ["other"] }, { tags: ["x", "x"] }, { activation: "other" }, { businessId: "x" }]) expect(SkillCardFilterSchema.safeParse(filter).success).toBe(false);
    const input = fixture();
    expect(() => createStandaloneAbilityRegistry([{ ...input.controller, rules: [{ ...removal, effects: [{ type: "remove-skill-cards", target: "owner", filter: { definitionIds: ["missing"] } }] }] }], [])).toThrow("Unknown filter ability");
    const value = { type: "effect-result", key: "removed" } as const;
    expect(AbilityRuleSchema.safeParse({ ...removal, effects: [...removal.effects].reverse() }).success).toBe(false);
    expect(AbilityRuleSchema.safeParse({ ...removal, effects: [removal.effects[0], removal.effects[0]] }).success).toBe(false);
    expect(AbilityRuleSchema.safeParse({ ...removal, conditions: [{ type: "scalar-compare", left: value, operator: "gt", right: 0 }] }).success).toBe(false);
    expect(AbilityDefinitionSchema.safeParse({ ...active, activation: { ...active.activation, availability: [{ type: "scalar-compare", left: value, operator: "gt", right: 0 }] } }).success).toBe(false);
    for (const activeValue of [value, { type: "skill-card-count", target: "event-actor" }]) expect(AbilityDisplaySchema.safeParse({ id: "bad", target: "owner", description: "Bad", content: [{ type: "text", text: "Bad" }], skillCardMarkers: [{ targets: ["rival"], active: activeValue, type: "bad", label: "Bad" }] }).success).toBe(false);
    expect(() => resolveScalar(value, { ...input, ability: input.runtime.instances[0] })).toThrow("unavailable");
  });
});

describe("generic hand transfer", () => {
  it.each(["shoe", "derived"] as const)("moves the identified %s Hit without copying or moving a later appended card", source => {
    const input = fixture([
      { id: "transfer", trigger: "before-bust-resolution", effects: [{ type: "transfer-hand-card", from: "owner", target: "rival", card: "last-hit-card" }] },
      { id: "observe", trigger: "after-card-acquired", effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: readout.id, values: { ["value"]: { type: "numeric", value: { type: "acquired-card-value", aceValue: "one" } } } }] }
    ]);
    const hit = source === "shoe" ? createCard("clubs", "8", "hit") : createDerivedCard("clubs", "8", "hit");
    const later = createDerivedCard("hearts", "2", "later");
    const world = { ...input.world, hands: { ...input.world.hands, opponent: { cards: [hit, later] } }, publicCardIds: [hit.id] };
    const result = resolveAbilityEvent({ ...input, world, event: { trigger: "before-bust-resolution", sourceEventId: "bust", eventActor: "opponent", lastHitCardIds: { opponent: hit.id } } });
    expect(result.world.hands.player.cards).toEqual([hit]);
    expect(result.world.hands.opponent.cards).toEqual([later]);
    expect(result.world.shoe).toEqual(world.shoe); expect(result.world.publicCardIds).toEqual([hit.id]);
    expect(result.world.statuses.find(status => status.statusDefinitionId === readout.id)?.parameters.value).toBe(8);
    expect(result.triggered.filter(id => id.endsWith(":observe"))).toHaveLength(1);
  });

  it("retains the implicit public identity when moving a first public card", () => {
    const input = fixture([{ id: "transfer", trigger: "before-turn", effects: [{ type: "transfer-hand-card", from: "owner", target: "rival", card: "first-public-card" }] }]);
    const first = input.world.hands.opponent.cards[0];
    const result = resolveAbilityEvent({ ...input, world: { ...input.world, publicCardIds: undefined, hands: { ...input.world.hands, player: { cards: [createCard("clubs", "2", "other")] } } } });
    expect(result.world.publicCardIds).toContain(first.id);
    expect(result.events).toContainEqual({ type: "CARD_REVEALED", target: "player", cardId: first.id });
  });

  it("composes a derived Hit bust transfer and forced Stand through the real reducer", () => {
    const original = ABILITY_REGISTRY;
    const statusId = "neutral-hit-rescued";
    const controller = { ...fixture().controller, rules: [
      { id: "replace", trigger: "before-card-draw", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "replace-pending-draw", target: "owner", policy: { type: "exact-resulting-total", total: 22, fallback: "create-derived-card" } }] },
      { id: "rescue", trigger: "before-bust-resolution", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "transfer-hand-card", from: "owner", target: "rival", card: "last-hit-card" }, { type: "add-status", target: "owner", statusDefinitionId: statusId }] },
      { id: "stand", trigger: "after-hit-resolved", conditions: [{ type: "status-present", target: "owner", statusDefinitionId: statusId }], effects: [{ type: "force-stand", target: "owner" }, { type: "remove-status", target: "owner", statusDefinitionId: statusId }] }
    ] };
    try {
      installAbilityRegistry([...original.definitions, controller], [...original.statuses, { id: statusId, defaultDuration: "round", rules: [] }], original.catalogVersion);
      const base = createMatch("neutral-transfer-hit", { opponentId: "claude", skillDeckIds: [], opponentAiSkills: [{ definitionId: controller.id, enabled: true, parameters: {} }] });
      const cards = ["2", "3", "9", "8", ...Array(30).fill("2")].map((rank, index) => createCard("clubs", rank as Rank, `neutral-physical-${index}`));
      const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, busted: false, stood: true, bustLimit: undefined };
      const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, busted: false, stood: false, bustLimit: undefined };
      const state = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 0 }, history: [{ type: "ROUND_STARTED" as const, roundIndex: 0 }], round: { ...base.round, player, opponent, phase: "turns" as const, currentActor: "opponent" as const, outcome: null } };
      const after = gameReducer(state, { type: "OPPONENT_HIT" });
      expect(after.player.hand.cards.at(-1)?.attributes).toMatchObject({ source: "derived", rank: "5" });
      expect(after.opponent.hand.cards).toEqual(opponent.hand.cards);
      expect(after.opponent.stood).toBe(true); expect(after.opponent.busted).toBe(false);
      expect(after.history).toContainEqual({ type: "OPPONENT_STOOD" });
      expect(after.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
      expect(after.shoe).toEqual(state.shoe);
      expect(validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(after)))).activeMatch?.opponent.stood).toBe(true);
    } finally { installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion); }
  });

  it("rejects a missing Hit identity and identical source/target atomically", () => {
    for (const from of ["owner", "rival"] as const) {
      const input = fixture([{ id: "transfer", trigger: "before-turn", effects: [{ type: "transfer-hand-card", from, target: "rival", card: "last-hit-card" }] }]);
      expect(() => resolveAbilityEvent(input)).toThrow(/unavailable|distinct/);
      expect(input.world.hands.player.cards).toEqual([]);
    }
  });
});
