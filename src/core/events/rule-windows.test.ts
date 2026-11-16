import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { AiSkillAbilityDefinition, PlayerSkillAbilityDefinition } from "../abilities/types";
import { createMatch, gameReducer, getActiveBustLimit, getLegalActions, previewComparisonScores, previewPendingTrigger } from "../match/reducer";
import { matchRuleWindows } from "./rule-windows";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));
const initial = () => createMatch("session-transition", { grantOpeningSkills: false });

describe("accepted rule window trace", () => {
  it("records windows even when no ability responds, without adding saved events", () => {
    const state = initial();
    const windows = matchRuleWindows(undefined, state);
    expect(windows.map(window => window.trigger)).toEqual(expect.arrayContaining(["before-round-deal", "on-match-created", "on-round-start"]));
    expect(state.history.some(event => event.type === "ABILITY_TRIGGERED")).toBe(false);
    expect(new Set(windows.map(window => window.id)).size).toBe(windows.length);
    expect(windows.every(window => window.matchId === state.id)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("sourceEventId");
    expect(Object.isFrozen(windows)).toBe(true);
    expect(Object.isFrozen(windows[0].event)).toBe(true);
    expect(Object.isFrozen(state)).toBe(false);
  });

  it("keeps previews and repeated legality queries silent and deterministic", () => {
    const before = initial();
    const recorded = matchRuleWindows(undefined, before);
    const snapshot = JSON.stringify(before);
    for (let index = 0; index < 3; index++) {
      getLegalActions(before); getActiveBustLimit(before, "player");
      previewComparisonScores(before); previewPendingTrigger(before);
    }
    expect(matchRuleWindows(undefined, before)).toEqual(recorded);
    expect(matchRuleWindows(before, before)).toEqual([]);
    expect(JSON.stringify(before)).toBe(snapshot);
    const after = gameReducer(before, { type: "PLAYER_STAND" });
    const repeated = gameReducer(before, { type: "PLAYER_STAND" });
    expect(after).toEqual(repeated);
    expect(matchRuleWindows(before, after)).toEqual(matchRuleWindows(before, repeated));
    expect(matchRuleWindows(before, after).some(window => window.sourceEventId.includes("preview"))).toBe(false);
  });

  it("omits failed ability transactions while keeping other accepted windows", () => {
    const source: AiSkillAbilityDefinition = {
      id: "example-window-failure", name: "Window failure", description: "Neutral fixture", sourceKind: "ai-skill",
      primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" }, rules: [
        { id: "invalid-pending", trigger: "before-turn", effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 1 }] }
      ]
    };
    installAbilityRegistry([...registry.definitions, source], registry.statuses, registry.catalogVersion);
    const state = createMatch("session-transition", { grantOpeningSkills: false,
      opponentAiSkills: [{ definitionId: source.id, enabled: true, parameters: {} }] });
    expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(true);
    expect(matchRuleWindows(undefined, state).some(window => window.trigger === "before-turn")).toBe(false);
    expect(matchRuleWindows(undefined, state).some(window => window.trigger === "before-round-deal")).toBe(true);
  });

  it("captures the pending draw supplied to the synchronous skill window", () => {
    const before = initial();
    const after = gameReducer(before, { type: "PLAYER_HIT" });
    const draw = matchRuleWindows(before, after).find(window => window.trigger === "before-card-draw")!;
    expect(draw.event.pendingDraw).toMatchObject({ actor: "player", id: draw.sourceEventId });
    expect(Object.isFrozen(draw.event.pendingDraw)).toBe(true);
    expect(draw.event.pendingDraw!.card).toEqual(before.shoe.cards[before.shoe.cursor]);
  });

  it("records nested acquisitions at their producing window and excludes the availability dry run", () => {
    const source: PlayerSkillAbilityDefinition = {
      id: "example-window-acquisition", name: "Window acquisition", description: "Neutral fixture", sourceKind: "player-skill",
      primaryDomain: "gambler", skillTags: ["gambler"], tags: ["neutral"], activation: { type: "action", consume: "card", windows: ["owner-turn"] },
      drop: { enabled: false, baseWeight: 1 }, stackable: false,
      rules: [{ id: "acquire", trigger: "on-ability-played", effects: [{ type: "acquire-card", target: "owner", choices: [
        { source: "derived", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "clubs" } }
      ] }] }]
    };
    installAbilityRegistry([...registry.definitions, source], registry.statuses, registry.catalogVersion);
    const before = createMatch("session-transition", { grantOpeningSkills: false,
      initialPlayerSkills: [{ definitionId: source.id, enabled: true, parameters: {} }] });
    const card = before.playerSkills.cards.find(card => card.definitionId === source.id)!;
    const after = gameReducer(before, { type: "PLAY_ABILITY", instanceId: card.instanceId });
    const windows = matchRuleWindows(before, after);
    expect(windows.filter(window => window.trigger === "on-ability-played")).toHaveLength(1);
    const acquired = windows.find(window => window.trigger === "after-card-acquired")!;
    expect(acquired.event.acquiredCards?.[0].attributes.rank).toBe("2");
    expect(acquired.event.initialHandCardCounts).toBeTruthy();
    expect(Object.isFrozen(acquired.event.acquiredCards?.[0])).toBe(true);
    expect(windows.some(window => window.trigger === "after-ability-played")).toBe(true);
  });

  it("supports durable catch-up and restores without replaying ephemeral traces", () => {
    const before = initial();
    const first = gameReducer(before, { type: "PLAYER_STAND" });
    const action = getLegalActions(first).find(action => action.type === "AI_TURN" || action.type === "ACK_ROUND_RESULT")!;
    expect(action).toBeTruthy();
    const second = gameReducer(first, action);
    expect(matchRuleWindows(before, second)).toEqual([...matchRuleWindows(before, first), ...matchRuleWindows(first, second)]);
    expect(matchRuleWindows(undefined, second, true)).toEqual([]);
    expect(matchRuleWindows(undefined, JSON.parse(JSON.stringify(second)))).toEqual([]);
    const invalid = gameReducer(before, { type: "SELECT_SKILL_DRAW", definitionId: "unavailable" });
    expect(invalid).toBe(before);
    expect(matchRuleWindows(before, invalid)).toEqual([]);
  });
});
