import { describe, expect, it } from "vitest";
import { createMatch, gameReducer, getLegalActions } from "../match/reducer";
import type { MatchState } from "../match/types";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { AbilityDefinition, AbilityRule, AiSkillAbilityDefinition, PlayerSkillAbilityDefinition } from "../abilities/types";
import { createMatchFactBatch } from "./batch";
import { MATCH_FACT_API_VERSION } from "./types";

const selfRemoving: PlayerSkillAbilityDefinition = {
  id: "example-self-removing", name: "Neutral source", description: "Neutral fact fixture",
  sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["neutral"],
  activation: { type: "passive" }, ttl: { type: "rounds", amount: 2 }, drop: { enabled: false, baseWeight: 1 }, stackable: false,
  rules: [{ id: "remove-self", trigger: "before-turn", effects: [{ type: "remove-skill-cards", target: "owner" }] }]
};

function withDefinitions(definitions: readonly AbilityDefinition[], run: () => void): void {
  const previous = ABILITY_REGISTRY;
  try {
    installAbilityRegistry([...previous.definitions, ...definitions], previous.statuses, previous.catalogVersion);
    run();
  } finally { installAbilityRegistry(previous.definitions, previous.statuses, previous.catalogVersion); }
}

function initialSkill(definition: PlayerSkillAbilityDefinition): MatchState {
  return createMatch("example-origin", { opponentId: "claude", openingSkillCards: 0, grantOpeningSkills: false,
    initialPlayerSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }] });
}

describe("accepted match facts", () => {
  it("captures exact effect origin after the producing source has removed itself", () => {
    withDefinitions([selfRemoving], () => {
      const state = initialSkill(selfRemoving);
      expect(state.abilities.instances.some(instance => instance.definitionId === selfRemoving.id)).toBe(false);
      const batch = createMatchFactBatch(undefined, state);
      const removed = batch.facts.find(fact => fact.type === "SKILL_CARDS_REMOVED")!;
      expect(batch.apiVersion).toBe(MATCH_FACT_API_VERSION);
      expect(removed.apiVersion).toBe(MATCH_FACT_API_VERSION);
      expect(removed.event.cards).toHaveLength(1);
      expect(removed.source).toEqual({ instanceId: removed.event.sourceInstanceId,
        definitionId: selfRemoving.id, owner: "player", level: 1, kind: "player-skill", ruleId: "remove-self" });
      expect(removed.cause?.trigger).toBe("before-turn");
      expect(removed.cause?.sourceEventId).toBeTruthy();
      expect(removed.id).toBe(`${state.id}:${removed.index}`);
      expect(batch.fromIndex).toBe(0);
      expect(batch.toIndex).toBe(state.history.length);
      expect(batch.events).toEqual(state.history);
      expect(JSON.parse(JSON.stringify(removed.event))).toEqual({
        type: "SKILL_CARDS_REMOVED", actor: "player", sourceInstanceId: removed.event.sourceInstanceId,
        cards: state.history.flatMap(event => event.type === "SKILL_CARDS_REMOVED" ? event.cards : [])
      });
    });
  });

  it("freezes detached fact payloads without freezing legacy events or domain state", () => {
    withDefinitions([selfRemoving], () => {
      const state = initialSkill(selfRemoving);
      const originalJson = JSON.stringify(state);
      const batch = createMatchFactBatch(undefined, state);
      const removed = batch.facts.find(fact => fact.type === "SKILL_CARDS_REMOVED")!;
      const original = state.history[removed.index];
      expect(batch.events[removed.index]).toBe(original);
      expect(removed.event).not.toBe(original);
      expect(Object.isFrozen(original)).toBe(false);
      expect(Object.isFrozen(state)).toBe(false);
      expect(Object.isFrozen(removed.event.cards)).toBe(true);
      expect(Object.isFrozen(removed.event.cards[0])).toBe(true);
      expect(Object.isFrozen(removed.source)).toBe(true);
      expect(Object.isFrozen(removed.cause)).toBe(true);
      expect(() => (removed.event.cards as unknown[]).pop()).toThrow();
      expect(JSON.stringify(state)).toBe(originalJson);
    });
  });

  it("keeps both sides of a round boundary, including effects before the new round marker", () => {
    const rules: AbilityRule[] = [
      { id: "old-round", trigger: "on-round-end", effects: [{ type: "add-gun-bullets", target: "owner", amount: 1 }] },
      { id: "new-round", trigger: "before-round-deal", effects: [{ type: "add-gun-bullets", target: "owner", amount: 1 }] }
    ];
    const source: AiSkillAbilityDefinition = { id: "example-round-source", name: "Neutral round source", description: "Neutral fact fixture",
      sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" }, rules };
    withDefinitions([source], () => {
      const initial = createMatch("example-round-facts", { opponentId: "claude", openingSkillCards: 0,
        opponentAiSkills: [{ definitionId: source.id, enabled: true, parameters: {} }] });
      const before = { ...initial, round: { ...initial.round, phase: "round-end" as const } };
      const after = gameReducer(before, { type: "CONTINUE_ROUND" });
      const batch = createMatchFactBatch(before, after);
      expect(batch.facts.find(fact => fact.source?.ruleId === "old-round")?.roundIndex).toBe(0);
      const preDeal = batch.facts.find(fact => fact.source?.ruleId === "new-round")!;
      expect(preDeal.roundIndex).toBe(1);
      expect(preDeal.index).toBeLessThan(batch.facts.find(fact => fact.type === "ROUND_STARTED")!.index);
      expect(batch.events).toEqual(after.history.slice(before.history.length));
      expect(batch.facts).toHaveLength(batch.events.length);
      expect(batch.fromIndex).toBe(before.history.length);
      expect(createMatchFactBatch(before, after)).toEqual(batch);
    });
  });

  it("does not publish effects from a transaction that later rolls back", () => {
    const failed: PlayerSkillAbilityDefinition = { ...selfRemoving, id: "example-failed-source",
      rules: [{ ...selfRemoving.rules[0], effects: [...selfRemoving.rules[0].effects,
        { type: "add-to-pending-comparison-score", target: "owner", amount: 1 }] }] };
    withDefinitions([failed], () => {
      const state = initialSkill(failed);
      expect(state.playerSkills.cards.some(card => card.definitionId === failed.id)).toBe(true);
      const batch = createMatchFactBatch(undefined, state);
      expect(batch.facts.some(fact => fact.type === "SKILL_CARDS_REMOVED")).toBe(false);
      expect(batch.facts.some(fact => fact.type === "ABILITY_RESOLUTION_FAILED")).toBe(true);
    });
  });

  it("keeps repeated legality dry runs silent and preserves deterministic actual outcomes", () => {
    const active: PlayerSkillAbilityDefinition = { ...selfRemoving, id: "example-active-source", ttl: undefined,
      activation: { type: "action", consume: "card", windows: ["owner-turn"] },
      rules: [{ id: "active-effect", trigger: "on-ability-played", effects: [{ type: "add-gun-bullets", target: "rival", amount: 1 }] }] };
    withDefinitions([active], () => {
      const state = initialSkill(active);
      const json = JSON.stringify(state), rng = structuredClone(state.rng);
      const first = getLegalActions(state), second = getLegalActions(state);
      expect(second).toEqual(first);
      expect(JSON.stringify(state)).toBe(json);
      expect(createMatchFactBatch(state, state).facts).toEqual([]);
      const action = first.find(action => action.type === "PLAY_ABILITY")!;
      expect(action).toBeTruthy();
      const after = gameReducer(state, action), repeated = gameReducer(state, action);
      expect(after).toEqual(repeated);
      expect(state.rng).toEqual(rng);
      const batch = createMatchFactBatch(state, after);
      expect(batch).toEqual(createMatchFactBatch(state, repeated));
      expect(batch.facts.filter(fact => fact.type === "ABILITY_PLAYED")).toHaveLength(1);
      expect(batch.facts.find(fact => fact.type === "ABILITY_RESULT")?.source?.ruleId).toBe("active-effect");
      expect(batch.facts.find(fact => fact.type === "ABILITY_PLAYED")?.source?.definitionId).toBe(active.id);
    });
  });

  it("retains the producing rule for multiple removals by the same ability", () => {
    const first: PlayerSkillAbilityDefinition = { ...selfRemoving, id: "example-first-card", rules: [] };
    const second: PlayerSkillAbilityDefinition = { ...first, id: "example-second-card" };
    const source: AiSkillAbilityDefinition = { id: "example-multi-rule-source", name: "Neutral source", description: "Neutral fact fixture",
      sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
      rules: [first, second].map((card, index) => ({ id: `remove-${index}`, trigger: "before-turn",
        effects: [{ type: "remove-skill-cards", target: "rival", filter: { definitionIds: [card.id] } }] })) };
    withDefinitions([first, second, source], () => {
      const state = createMatch("example-exact-rule", { opponentId: "claude", openingSkillCards: 0, grantOpeningSkills: false,
        initialPlayerSkills: [first, second].map(card => ({ definitionId: card.id, enabled: true, parameters: {} })),
        opponentAiSkills: [{ definitionId: source.id, enabled: true, parameters: {} }] });
      const removals = createMatchFactBatch(undefined, state).facts.filter(fact => fact.type === "SKILL_CARDS_REMOVED");
      expect(removals.map(fact => [fact.event.cards[0].definitionId, fact.source?.ruleId])).toEqual([
        [first.id, "remove-0"], [second.id, "remove-1"]
      ]);
      expect(removals[0].source?.instanceId).toBe(removals[1].source?.instanceId);
    });
  });

  it("restores only a history cursor, without replaying facts or inventing lost origin metadata", () => {
    withDefinitions([selfRemoving], () => {
      const original = initialSkill(selfRemoving);
      const restored: MatchState = JSON.parse(JSON.stringify(original));
      const batch = createMatchFactBatch(undefined, restored, { restored: true });
      expect(batch).toMatchObject({ restored: true, events: [], facts: [],
        fromIndex: restored.history.length, toIndex: restored.history.length });
      // Diagnostic callers can wrap raw old history, but there is no guessed
      // attribution based on adjacent ability notifications or current instances.
      const historical = createMatchFactBatch(undefined, restored).facts.find(fact => fact.type === "SKILL_CARDS_REMOVED")!;
      expect(historical.source).toBeUndefined();
      expect(historical.cause).toBeUndefined();
      expect(historical.id).toBe(createMatchFactBatch(undefined, original).facts.find(fact => fact.type === "SKILL_CARDS_REMOVED")!.id);
    });
  });

  it("rejects crossing match identities or rewinding the accepted history", () => {
    const state = createMatch("example-cursor", { openingSkillCards: 0 });
    expect(() => createMatchFactBatch(state, { ...state, id: "another-match" })).toThrow("match identities");
    expect(() => createMatchFactBatch(state, { ...state, history: [] })).toThrow("rewind");
  });
});
