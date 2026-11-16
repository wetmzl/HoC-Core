import { describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { PlayerSkillAbilityDefinition } from "../abilities/types";
import { createMatch } from "../match/reducer";
import { createPublicEvent, createPublicEventBatch, snapshotPublicEventBatch } from "./public-events";
import { readPublicQuery, type PublicQuery } from "./public-queries";
import { evaluatePublicCondition, selectPublicTriggerEvents } from "./triggers";
import { getPlayerSkillDefinition } from "../skills/definitions";

const passive: PlayerSkillAbilityDefinition = {
  id: "public-model-passive", name: "Neutral passive", description: "Neutral registry fixture",
  sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["neutral"],
  activation: { type: "passive" }, ttl: { type: "rounds", amount: 3 }, drop: { enabled: false, baseWeight: 1 }, stackable: false,
  rules: [
    { id: "limit", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 5 }] },
    { id: "score", trigger: "before-round-resolution", effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 2 }] }
  ]
};
const active: PlayerSkillAbilityDefinition = {
  ...passive, id: "public-model-active", name: "Neutral active", ttl: undefined,
  activation: { type: "action", consume: "card", windows: ["owner-turn"] },
  rules: [{ id: "play", trigger: "on-ability-played", effects: [{ type: "add-gun-bullets", target: "rival", amount: 1 }] }]
};

describe("host-owned public match semantics", () => {
  it("preserves host queries and trigger results after the consumer switches to an empty registry", () => {
    const previous = ABILITY_REGISTRY;
    try {
      installAbilityRegistry([...previous.definitions, passive, active], previous.statuses, previous.catalogVersion);
      const state = createMatch("host-model", { grantOpeningSkills: false, openingSkillCards: 0, initialPlayerSkills: [
        { definitionId: passive.id, enabled: true, parameters: {} }, { definitionId: active.id, enabled: true, parameters: {} }
      ] });
      const inspected = state.playerSkills.cards.find(card => card.definitionId === passive.id)!;
      const fact = createPublicEvent({ id: "host-model:created", type: "match.created", scopes: { match: state.id } });
      const host = createPublicEventBatch({ id: "host-model", facts: [fact], context: { match: state,
        presentation: { inspectedSkill: { definitionId: inspected.definitionId, instanceId: inspected.instanceId } } } });
      const queries: readonly PublicQuery[] = [
        { id: "match.action-available", action: "PLAY_ABILITY" }, { id: "match.playable-skill" },
        { id: "match.bust-limit", actor: "player" }, { id: "match.comparison-modified" },
        { id: "match.passive-skill-present" }, { id: "match.inspected-skill-lifetime" }
      ];
      const expected = queries.map(query => readPublicQuery(query, { event: fact, batch: host }));
      expect(expected).toEqual([true, true, 26, true, true, true]);
      const detached = JSON.parse(JSON.stringify(host));
      installAbilityRegistry([], [], previous.catalogVersion);
      // Simulates an independently bundled SDK with no host content registry installed.
      const consumer = snapshotPublicEventBatch(detached);
      expect(queries.map(query => readPublicQuery(query, { event: consumer.facts[0], batch: consumer }))).toEqual(expected);
      expect(evaluatePublicCondition({ type: "compare", left: { type: "query", query: { id: "match.bust-limit", actor: "player" } },
        operator: "eq", right: { type: "literal", value: 26 } }, { batch: consumer })).toBe(true);
      expect(selectPublicTriggerEvents({ on: ["match.created"], when: { type: "compare",
        left: { type: "query", query: { id: "match.playable-skill" } }, operator: "eq", right: { type: "literal", value: true }
      } }, consumer)).toHaveLength(1);
      expect(Object.isFrozen(consumer.context?.matchQueries?.legalActionTypes)).toBe(true);
      expect(Object.isFrozen(consumer.context?.matchQueries?.skillLifetimes)).toBe(true);
      // Prove the test changed registries rather than accidentally exercising the same host data twice.
      expect(getPlayerSkillDefinition(passive.id)).toBeUndefined();
      expect(readPublicQuery({ id: "match.passive-skill-present" }, { match: state })).toBeUndefined();
    } finally { installAbilityRegistry(previous.definitions, previous.statuses, previous.catalogVersion); }
  });

  it("does not invent registry-dependent answers when an external batch lacks host semantics", () => {
    const state = createMatch("missing-host-model", { openingSkillCards: 0 });
    const raw = { id: "external", restored: false, facts: [], context: { match: state } };
    const consumer = snapshotPublicEventBatch(raw);
    expect(consumer.context?.matchQueries).toBeUndefined();
    expect(readPublicQuery({ id: "match.action-available", action: "PLAYER_HIT" }, { batch: consumer })).toBeUndefined();
    expect(readPublicQuery({ id: "match.bust-limit", actor: "player" }, { batch: consumer })).toBeUndefined();
    expect(readPublicQuery({ id: "match.passive-skill-present" }, { batch: consumer })).toBeUndefined();
    expect(readPublicQuery({ id: "match.action-available", action: "PLAYER_HIT" }, { match: state })).toBeUndefined();
    expect(readPublicQuery({ id: "match.bust-limit", actor: "player" }, { match: state })).toBeUndefined();
    expect(evaluatePublicCondition({ type: "not", condition: { type: "compare",
      left: { type: "query", query: { id: "match.passive-skill-present" } }, operator: "eq", right: { type: "literal", value: true }
    } }, { batch: consumer })).toBeUndefined();
    expect(readPublicQuery({ id: "match.status" }, { batch: consumer })).toBe(state.status);
  });
});
