import { describe, expect, it } from "vitest";
import { createMatch, gameReducer } from "../match/reducer";
import { AbilityRuleSchema } from "../abilities/schema";
import { createMatchFactBatch } from "./batch";
import { createPublicEvent, createPublicEventBatch, matchPublicEventBatch, snapshotPublicEventBatch } from "./public-events";
import { getPublicEventDeclaration, MATCH_EVENT_TYPES, PUBLIC_EVENT_CATALOG } from "./public-event-catalog";
import { ABILITY_BROADCAST_TRIGGER_TYPES } from "./trigger-catalog";
import { matchRuleWindows } from "./rule-windows";

describe("public occurrence envelope", () => {
  it("preserves original accepted identities and actual rule window occurrences in order", () => {
    const before = createMatch("public-facts", { openingSkillCards: 0 });
    const after = gameReducer(before, { type: "PLAYER_STAND" });
    const source = createMatchFactBatch(before, after);
    const batch = matchPublicEventBatch(source, { game: "runtime", program: "run" });
    expect(batch.context?.match).toEqual(after);
    expect(batch.context?.match).not.toBe(after);
    for (const fact of source.facts) {
      const observed = batch.facts.find(event => event.id === fact.id)!;
      expect(observed.type).toBe(`match.${fact.type}`);
      expect(observed.origin).toMatchObject({ factId: fact.id, matchId: fact.matchId, historyIndex: fact.index });
      expect(observed.scopes).toMatchObject({ game: "runtime", program: "run", match: after.id, round: `${after.id}:${fact.roundIndex}` });
      expect(observed.data).toEqual(fact.event);
    }
    const windows = matchRuleWindows(before, after);
    expect(windows.length).toBeGreaterThan(0);
    expect(batch.facts.filter(event => event.type.startsWith("rule.")).map(event => event.id)).toEqual(windows.map(window => window.id));
    for (const window of windows) {
      const event = batch.facts.find(event => event.id === window.id)!;
      expect(event.data.event).toEqual(window.event);
      expect(event.data.trigger).toBe(window.trigger);
    }
    const indices = batch.facts.map(event => event.origin?.historyIndex ?? -1);
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
  });

  it("captures initialization windows even when no skill responds and never replays restored occurrences", () => {
    const state = createMatch("public-init", { openingSkillCards: 0 });
    const fresh = matchPublicEventBatch(createMatchFactBatch(undefined, state));
    expect(fresh.facts.some(event => event.type === "rule.on-match-created")).toBe(true);
    expect(fresh.facts.some(event => event.type === "rule.before-round-deal")).toBe(true);
    expect(fresh.facts.filter(event => event.type === "match.created")).toHaveLength(1);
    expect(fresh.facts[0].type).toBe("match.created");
    expect(matchPublicEventBatch(createMatchFactBatch(undefined, state, { restored: true })).facts).toEqual([]);
    expect(createPublicEventBatch({ id: "restored", restored: true, facts: fresh.facts }).facts).toEqual([]);
  });

  it("detaches occurrence data without freezing gameplay; plugin snapshots detach final state", () => {
    const data = { value: 1, nested: { label: "before" } };
    const event = createPublicEvent({ id: "one", type: "program.started", scopes: { program: "run" }, data });
    data.nested.label = "after";
    expect(event.data.nested).toEqual({ label: "before" });
    expect(Object.isFrozen(event.data.nested)).toBe(true);
    const state = createMatch("public-snapshot");
    const batch = createPublicEventBatch({ id: "batch", facts: [event], context: { match: state } });
    expect(Object.isFrozen(state)).toBe(false);
    expect(batch.context?.match).not.toBe(state);
    const source = JSON.stringify(state);
    expect(() => { (batch.context!.match!.rng.deck as { state: number }).state = 0; }).toThrow();
    expect(() => { (batch.context!.match!.player.hand.cards as unknown[]).pop(); }).toThrow();
    expect(JSON.stringify(state)).toBe(source);
    const snapshot = snapshotPublicEventBatch(batch);
    expect(snapshot.context?.match).toEqual(state);
    expect(snapshot.context?.match).not.toBe(state);
    expect(Object.isFrozen(snapshot.context?.match?.player.hand.cards)).toBe(true);
    expect(Object.isFrozen(state.player.hand.cards)).toBe(false);
    expect(() => createPublicEventBatch({ id: "duplicate", facts: [event, event] })).toThrow("重复");
    expect(() => createPublicEvent({ id: "", type: "program.started", scopes: {} })).toThrow();
  });

  it("derives match and skill window topics from their existing schema source", () => {
    expect(new Set(MATCH_EVENT_TYPES).size).toBe(MATCH_EVENT_TYPES.length);
    expect(MATCH_EVENT_TYPES).toContain("HAND_CARD_DISCARDED");
    expect(MATCH_EVENT_TYPES).toContain("MATCH_FINISHED");
    expect(AbilityRuleSchema.shape.trigger.options).toEqual([...ABILITY_BROADCAST_TRIGGER_TYPES]);
    expect(PUBLIC_EVENT_CATALOG.filter(entry => entry.type.startsWith("rule.")).map(entry => entry.type))
      .toEqual(ABILITY_BROADCAST_TRIGGER_TYPES.map(trigger => `rule.${trigger}`));
    expect(getPublicEventDeclaration("match.TRIGGER_PULLED")?.stages).toEqual(["resolved", "committed"]);
    expect(getPublicEventDeclaration("core.screen-entered")?.stages).toEqual(["resolved"]);
    expect(getPublicEventDeclaration("core.duel-requested")).toMatchObject({ apiVersion: 1, scopes: ["game"], stages: ["resolved"] });
    expect(getPublicEventDeclaration("match.NOT_REAL")).toBeUndefined();
  });
});
