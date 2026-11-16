import { describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { abilityRuleWindows } from "../events/rule-windows";
import { SeededRng } from "../rng/seeded";
import { resolveAbilityEvent } from "./engine";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime, expireStatuses, garbageCollectAbilityInstances } from "./runtime";
import type { AbilityActor, AbilityDefinition, AbilityWorld, Effect, PlayerSkillAbilityDefinition, SkillCardFilter, StatusDefinition } from "./types";

function active(id: string, effects: readonly Effect[] = [{ type: "add-gun-bullets", target: "owner", amount: 1 }]): PlayerSkillAbilityDefinition {
  return { id, name: id, description: "Neutral held action", sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["active"],
    drop: { enabled: true, baseWeight: 1 }, stackable: false, activation: { type: "action", windows: ["owner-turn"], consume: "card" },
    rules: [{ id: "apply", trigger: "on-ability-played", effects }] };
}

function fixture(actions: readonly PlayerSkillAbilityDefinition[] = [active("sample-active")], options: { owner?: AbilityActor; seed?: string; filter?: SkillCardFilter; extraEffects?: readonly Effect[]; observers?: readonly AbilityDefinition[]; statuses?: readonly StatusDefinition[] } = {}) {
  const owner = options.owner ?? "opponent";
  const caster: AbilityActor = owner === "player" ? "opponent" : "player";
  const invoker: AbilityDefinition = { id: "sample-invoker", name: "Invoker", description: "Neutral automatic invocation", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["invoker"], activation: { type: "automatic" },
    rules: [{ id: "invoke", trigger: "after-card-draw", limit: { perRound: 4 }, effects: [{ type: "invoke-random-active-skill", target: "rival", ...(options.filter ? { filter: options.filter } : {}) }, ...(options.extraEffects ?? [])] }] };
  const registry = createStandaloneAbilityRegistry([invoker, ...actions, ...(options.observers ?? [])], options.statuses ?? []);
  let runtime = addAbilityInstance(createAbilityRuntime(new SeededRng(options.seed ?? "neutral-invocation").snapshot()), instantiateAbility({ definitionId: invoker.id, enabled: true, parameters: {} }, owner, "invoker", 1, registry, "ai-skill"), registry);
  const cards = actions.map(action => {
    const instance = instantiateAbility({ definitionId: action.id, enabled: true, parameters: {} }, caster, `held-${action.id}`, runtime.sequence + 1, registry);
    runtime = addAbilityInstance(runtime, instance, registry);
    return { kind: "player-skill" as const, definitionId: action.id, owner: caster, level: 1, instanceId: instance.instanceId };
  });
  for (const observer of options.observers ?? []) runtime = addAbilityInstance(runtime, instantiateAbility({ definitionId: observer.id, enabled: true, parameters: {} }, caster, observer.id, runtime.sequence + 1, registry, observer.sourceKind), registry);
  const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [createCard("clubs", "2", "remaining")], cursor: 0, shuffleIndex: 0 }, cards, skillDraws: 0, statuses: [], stood: { player: false, opponent: false } };
  return { registry, runtime, world, event: { trigger: "after-card-draw" as const, sourceEventId: "draw", eventActor: caster, roundHitCounts: { player: 2, opponent: 2 } },
    actionWindowFor: (actor: AbilityActor) => actor === caster ? "owner-turn" as const : undefined, bustLimitFor: () => 21 };
}

describe("held active skill invocation", () => {
  it.each(["player", "opponent"] as const)("uses and consumes the rival's actual card for an invocation owned by %s", owner => {
    const input = fixture(undefined, { owner });
    const before = JSON.stringify(input);
    const after = resolveAbilityEvent(input);
    const caster = owner === "player" ? "opponent" : "player";
    expect(after.world.guns[caster].bullets).toBe(1);
    expect(after.world.guns[owner].bullets).toBe(0);
    expect(after.world.cards).toEqual([]);
    expect(after.runtime.instances.map(instance => instance.instanceId)).toEqual(["invoker"]);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "ABILITY_PLAYED", owner: caster, definitionId: "sample-active", instanceId: "held-sample-active" }));
    expect(after.runtime.lastPlayedPlayerSkillDefinitionId).toBe(caster === "player" ? "sample-active" : null);
    expect(after.world.skillAcquisitionCounts).toEqual(input.world.skillAcquisitionCounts);
    expect(JSON.stringify(input)).toBe(before);
    expect(resolveAbilityEvent(input)).toEqual(after);
  });

  it("selects from usable held cards without consuming candidate preflight RNG", () => {
    const first = active("first", [{ type: "acquire-card", target: "owner", choices: [{ source: "derived", rank: { type: "static", rank: "3" }, suit: { type: "uniform-ability-rng" } }] }]);
    const second = { ...first, id: "second", name: "second" };
    const input = fixture([first, second]);
    const expected = SeededRng.fromSnapshot(input.runtime.rng);
    const definitionId = ["first", "second"][expected.nextInt(2)];
    expected.nextInt(4);
    expected.next(); // Derived-card identity uses the same saved ability stream.
    const after = resolveAbilityEvent(input);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "ABILITY_PLAYED", definitionId }));
    expect(after.runtime.rng).toEqual(expected.snapshot());
    expect(after.world.cards.map(card => card.definitionId)).toEqual([definitionId === "first" ? "second" : "first"]);
    expect(after.world.hands.player.cards).toHaveLength(1);
    expect(after.world.shoe).toEqual(input.world.shoe);
  });

  it("filters passive, blocked, unavailable and invalid-context cards", () => {
    const valid = active("valid");
    const passive = { ...active("passive"), activation: { type: "passive" as const }, ttl: { type: "rounds" as const, amount: 1 } };
    const blocked = { ...active("blocked"), tags: ["blocked"] };
    const unavailable = { ...active("unavailable"), activation: { type: "action" as const, windows: ["owner-turn" as const], consume: "card" as const, availability: [{ type: "hand-card-count" as const, target: "owner" as const, operator: "gt" as const, value: 0 }] } };
    const invalidContext = active("invalid-context", [{ type: "discard-hand-card", target: "owner", card: "last-card" }]);
    const input = fixture([valid, passive, blocked, unavailable, invalidContext], { statuses: [{ id: "block", defaultDuration: "round", blocksAbilityTags: ["blocked"], rules: [] }] });
    const statuses = [{ statusDefinitionId: "block", owner: "player" as const, sourceInstanceId: "invoker", stacks: 1, duration: "round" as const, parameters: {}, createdAtSequence: 2 }];
    const after = resolveAbilityEvent({ ...input, world: { ...input.world, statuses }, runtime: { ...input.runtime, statuses } });
    expect(after.events.filter(event => event.type === "ABILITY_PLAYED")).toEqual([expect.objectContaining({ definitionId: "valid" })]);
    expect(after.world.cards.map(card => card.definitionId)).toEqual(["passive", "blocked", "unavailable", "invalid-context"]);
  });

  it.each(["empty", "wrong-window", "passive-only"] as const)("skips an %s inventory without RNG, cards or rule budgets", mode => {
    const input = mode === "passive-only"
      ? fixture([{ ...active("passive"), activation: { type: "passive" }, ttl: { type: "rounds", amount: 1 } }])
      : fixture(mode === "empty" ? [] : undefined);
    const after = resolveAbilityEvent({ ...input, ...(mode === "wrong-window" ? { actionWindowFor: () => undefined } : {}) });
    expect(after.events).toEqual([]);
    expect(after.runtime.rng).toEqual(input.runtime.rng);
    expect(after.runtime.counters).toEqual(input.runtime.counters);
    expect(after.runtime.sequence).toBe(input.runtime.sequence);
    expect(after.world.cards).toEqual(input.world.cards);
  });

  it("can consume a held active card even when that definition is outside the drop pool", () => {
    const action = { ...active("not-droppable"), drop: { enabled: false, baseWeight: 1 } };
    const after = resolveAbilityEvent(fixture([action]));
    expect(after.world.cards).toEqual([]);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "ABILITY_PLAYED", definitionId: action.id }));
  });

  it("uses an optional inventory filter while preserving other active cards", () => {
    const input = fixture([active("first"), active("second")], { filter: { definitionIds: ["second"] } });
    const after = resolveAbilityEvent(input);
    expect(after.world.cards.map(card => card.definitionId)).toEqual(["first"]);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "ABILITY_PLAYED", definitionId: "second" }));
  });

  it("spends one use of a multi-use card and retains the same card and status source", () => {
    const action = { ...active("lasting", [{ type: "add-status", target: "owner", statusDefinitionId: "lasting-state" }]), activation: { type: "action" as const, windows: ["owner-turn" as const], consume: "card" as const, uses: 3 } };
    const input = fixture([action], { statuses: [{ id: "lasting-state", defaultDuration: "round", rules: [] }] });
    const after = resolveAbilityEvent(input);
    expect(after.world.cards).toEqual(input.world.cards);
    expect(after.runtime.statuses).toHaveLength(1);
    const instance = after.runtime.instances.find(candidate => candidate.instanceId === "held-lasting")!;
    expect(instance).toMatchObject({ owner: "player", remainingUses: 2 });
    const again = resolveAbilityEvent({ ...input, world: after.world, runtime: after.runtime, event: { ...input.event, sourceEventId: "second" } });
    const exhausted = resolveAbilityEvent({ ...input, world: again.world, runtime: again.runtime, event: { ...input.event, sourceEventId: "third" } });
    expect(exhausted.world.cards).toEqual([]);
    expect(exhausted.runtime.instances.find(candidate => candidate.instanceId === "held-lasting")?.remainingUses).toBe(0);
    expect(garbageCollectAbilityInstances(expireStatuses(exhausted.runtime, "round"), [], input.registry).instances.map(candidate => candidate.instanceId)).toEqual(["invoker"]);
  });

  it("executes the held card's actual level and parameter snapshot", () => {
    const action = { ...active("leveled"), parameters: { amount: { type: "number" as const, default: 1 } }, levels: [{ level: 2, rules: [{ id: "apply", trigger: "on-ability-played" as const, effects: [{ type: "add-gun-bullets" as const, target: "owner" as const, amount: { type: "parameter" as const, key: "amount" } }] }] }] };
    const input = fixture([action]);
    const held = instantiateAbility({ definitionId: "leveled", level: 2, enabled: true, parameters: { amount: 3 } }, "player", "held-leveled", 2, input.registry);
    const after = resolveAbilityEvent({ ...input, world: { ...input.world, cards: input.world.cards.map(card => ({ ...card, level: 2 })) }, runtime: { ...input.runtime, instances: input.runtime.instances.map(instance => instance.instanceId === held.instanceId ? held : instance) } });
    expect(after.world.guns.player.bullets).toBe(3);
    expect(after.world.cards).toEqual([]);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "ABILITY_PLAYED", definitionId: "leveled", level: 2 }));
    expect(after.runtime.lastPlayedPlayerSkillLevel).toBe(2);
  });

  it("retains the real card after a probability miss and only advances the saved RNG", () => {
    const action = active("chance");
    const input = fixture([{ ...action, rules: action.rules.map(rule => ({ ...rule, chance: 0 })) }]);
    const expected = SeededRng.fromSnapshot(input.runtime.rng);
    expected.nextInt(1);
    expected.next();
    const after = resolveAbilityEvent(input);
    expect(after.world.cards).toEqual(input.world.cards);
    expect(after.world.guns).toEqual(input.world.guns);
    expect(after.events).toEqual([]);
    expect(after.runtime.counters).toEqual(input.runtime.counters);
    expect(after.runtime.rng).toEqual(expected.snapshot());
    expect(after.runtime.lastPlayedPlayerSkillDefinitionId).toBeNull();
  });

  it("broadcasts acquisition and successful play exactly once, with real rule windows", () => {
    const action = active("acquirer", [{ type: "acquire-card", target: "owner", choices: [{ source: "derived", rank: { type: "static", rank: "3" }, suit: { type: "static", suit: "clubs" } }] }]);
    const observers = ["after-card-acquired", "after-ability-played"].map((trigger, index): AbilityDefinition => ({ id: `observer-${index}`, name: "Observer", description: "Counts actual broadcasts", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["observer"], activation: { type: "automatic" }, rules: [{ id: "observe", trigger: trigger as "after-card-acquired" | "after-ability-played", effects: [{ type: "set-status-stacks", target: "owner", statusDefinitionId: `count-${index}`, amount: { type: "add", left: { type: "status-stacks", target: "owner", statusDefinitionId: `count-${index}` }, right: 1 } }] }] }));
    const input = fixture([action], { observers, statuses: [0, 1].map(index => ({ id: `count-${index}`, defaultDuration: "match", rules: [] })) });
    const after = resolveAbilityEvent(input);
    expect(after.runtime.statuses.map(status => status.stacks)).toEqual([1, 1]);
    expect(abilityRuleWindows(after).filter(window => window.event.trigger === "on-ability-played")).toHaveLength(1);
    expect(abilityRuleWindows(after).filter(window => window.event.trigger === "after-ability-played")).toHaveLength(1);
    expect(abilityRuleWindows(after).filter(window => window.event.trigger === "after-card-acquired")).toHaveLength(1);
    expect(after.runtime.lastPlayedPlayerSkillDefinitionId).toBe("acquirer");
  });

  it("rolls back card consumption, child effects and RNG when a later parent effect fails", () => {
    const input = fixture(undefined, { extraEffects: [{ type: "discard-hand-card", target: "rival", card: "last-card" }] });
    const before = JSON.stringify(input);
    expect(() => resolveAbilityEvent(input)).toThrow("Selected hand card is unavailable");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("bounds cyclic invocation without consuming unusable cards", () => {
    const first = active("recursive-first", [{ type: "invoke-random-active-skill", target: "owner" }]);
    const second = active("recursive-second", [{ type: "invoke-random-active-skill", target: "owner" }]);
    const input = fixture([first, second]);
    const after = resolveAbilityEvent(input);
    expect(after.events).toEqual([]);
    expect(after.runtime.rng).toEqual(input.runtime.rng);
    expect(after.world.cards).toEqual(input.world.cards);
  });
});
