import type { CharacterDialogue, DialogueAnchor, DialogueCondition, DialogueRule, DialogueTest } from "./types";

const fact = (name: string, test: DialogueTest, args: Readonly<Record<string, unknown>> = {}): DialogueCondition => ({ primitive: `core.${name}`, apiVersion: 1, args, test });
const all = (...conditions: DialogueCondition[]): DialogueCondition => ({ all: conditions });
const any = (...conditions: DialogueCondition[]): DialogueCondition => ({ any: conditions });
const not = (condition: DialogueCondition): DialogueCondition => ({ not: condition });
const rule = (id: string, when: DialogueCondition, anchor: DialogueAnchor, poolId = id): DialogueRule => ({ id, on: [{ type: anchor === "round-start" ? "core.round-start" : anchor === "round-result" ? "core.round-result" : anchor === "round-acknowledged" ? "core.trigger-ready" : anchor === "trigger-result" ? "core.trigger-result" : "core.action", apiVersion: 1 }], when, poolId, anchor });

/** Editable authoring preset. Empty pools must be filled before package validation. */
export function createDialogueDraft(): CharacterDialogue {
  const rules: DialogueRule[] = [
    rule("PLAYER_TRIGGER_READY", fact("phase", { eq: "roulette-reaction" }), "round-acknowledged"),
    rule("PLAYER_TRIGGER_HIT", all(
      fact("phase", { eq: "roulette-result" }),
      fact("trigger-actor", { eq: "player" }),
      fact("trigger-result", { eq: "fired" }),
    ), "trigger-result"),
    rule("PLAYER_SURVIVED_TRIGGER", all(
      fact("phase", { eq: "roulette-result" }),
      fact("trigger-actor", { eq: "player" }),
      not(fact("trigger-result", { eq: "fired" })),
    ), "trigger-result"),
    rule("OPPONENT_TRIGGER_READY", fact("phase", { eq: "roulette-trigger" }), "round-acknowledged"),
    rule("OPPONENT_TRIGGER_HIT", all(
      fact("phase", { eq: "roulette-result" }),
      fact("trigger-actor", { eq: "opponent" }),
      fact("trigger-result", { eq: "fired" }),
    ), "trigger-result"),
    rule("OPPONENT_SURVIVED_TRIGGER", all(
      fact("phase", { eq: "roulette-result" }),
      fact("trigger-actor", { eq: "opponent" }),
      not(fact("trigger-result", { eq: "fired" })),
    ), "trigger-result"),
    rule("SPECIAL_TWENTY_ONE_PUSH", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-winner", { eq: null }),
      fact("hand-total", { eq: 21 }, { actor: "player", snapshot: "round-result" }),
      fact("hands-total-equal", { eq: true }, { snapshot: "round-result" }),
    ), "round-result"),
    rule("SPECIAL_LOW_PUSH", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-winner", { eq: null }),
      fact("hand-total", { range: { min: 12, max: 16 } }, { actor: "player", snapshot: "round-result" }),
      fact("hands-total-equal", { eq: true }, { snapshot: "round-result" }),
    ), "round-result"),
    rule("PLAYER_BLACKJACK", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-reason", { eq: "blackjack" }),
      fact("round-winner", { eq: "player" }),
    ), "round-result"),
    rule("PLAYER_BUST", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-reason", { eq: "bust" }),
      fact("penalty-target", { eq: "player" }),
    ), "round-result"),
    rule("PLAYER_WIN_ROUND", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-reason", { eq: "comparison" }),
      fact("round-winner", { eq: "player" }),
    ), "round-result"),
    rule("OPPONENT_BLACKJACK", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-reason", { eq: "blackjack" }),
      fact("round-winner", { eq: "opponent" }),
    ), "round-result"),
    rule("OPPONENT_BUST", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-reason", { eq: "bust" }),
      fact("penalty-target", { eq: "opponent" }),
    ), "round-result"),
    rule("OPPONENT_WIN_ROUND", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-reason", { eq: "comparison" }),
      fact("round-winner", { eq: "opponent" }),
    ), "round-result"),
    rule("PUSH_ROUND", all(
      fact("phase", { eq: "round-reveal" }),
      fact("round-winner", { eq: null }),
    ), "round-result"),
    rule("PLAYER_HIT", all(
      fact("phase", { eq: "turns" }),
      fact("last-action-actor", { eq: "player" }),
      fact("last-action", { eq: "hit" }, { actor: "any" }),
    ), "last-action"),
    rule("PLAYER_STAND", all(
      fact("phase", { eq: "turns" }),
      fact("last-action-actor", { eq: "player" }),
      fact("last-action", { eq: "stand" }, { actor: "any" }),
    ), "last-action"),
    rule("OPPONENT_FIRST_STAND", all(
      fact("phase", { eq: "turns" }),
      fact("last-action-actor", { eq: "opponent" }),
      fact("last-action", { eq: "stand" }, { actor: "any" }),
      fact("action-count", { eq: 1 }, { actor: "opponent", kind: "all" }),
    ), "last-action"),
    rule("OPPONENT_REPEAT_HIT_AFTER_PLAYER_STAND", all(
      fact("phase", { eq: "turns" }),
      fact("last-action-actor", { eq: "opponent" }),
      fact("last-action", { eq: "hit" }, { actor: "any" }),
      fact("action-count", { range: { min: 2 } }, { actor: "opponent", kind: "hit" }),
      fact("action-count", { range: { min: 1 } }, { actor: "player", kind: "stand" }),
    ), "last-action"),
    rule("OPPONENT_FIRST_HIT", all(
      fact("phase", { eq: "turns" }),
      fact("last-action-actor", { eq: "opponent" }),
      fact("last-action", { eq: "hit" }, { actor: "any" }),
      fact("action-count", { eq: 1 }, { actor: "opponent", kind: "all" }),
    ), "last-action"),
    rule("PLAYER_HIT-retained", all(
      fact("phase", { eq: "turns" }),
      fact("last-action", { eq: "hit" }, { actor: "player" }),
    ), "last-player-action", "PLAYER_HIT"),
    rule("PLAYER_STAND-retained", all(
      fact("phase", { eq: "turns" }),
      fact("last-action", { eq: "stand" }, { actor: "player" }),
    ), "last-player-action", "PLAYER_STAND"),
    rule("MATCH_START", any(
      fact("phase", { eq: "dealing" }),
      fact("phase", { eq: "initial-blackjack-check" }),
      fact("phase", { eq: "settlement" }),
      fact("phase", { eq: "round-end" }),
      fact("phase", { eq: "turns" }),
    ), "round-start"),
  ];
  return {
    pools: Object.fromEntries([
      "MATCH_START",
      "PLAYER_HIT",
      "PLAYER_STAND",
      "OPPONENT_FIRST_HIT",
      "OPPONENT_FIRST_STAND",
      "OPPONENT_REPEAT_HIT_AFTER_PLAYER_STAND",
      "PLAYER_BLACKJACK",
      "OPPONENT_BLACKJACK",
      "PLAYER_BUST",
      "OPPONENT_BUST",
      "PLAYER_SURVIVED_TRIGGER",
      "OPPONENT_SURVIVED_TRIGGER",
      "PLAYER_WIN_ROUND",
      "OPPONENT_WIN_ROUND",
      "PUSH_ROUND",
      "PLAYER_TRIGGER_READY",
      "OPPONENT_TRIGGER_READY",
      "PLAYER_TRIGGER_HIT",
      "OPPONENT_TRIGGER_HIT",
      "SPECIAL_TWENTY_ONE_PUSH",
      "SPECIAL_LOW_PUSH",
    ].map(id => [id, []])),
    rules,
    fallbackPoolId: "MATCH_START"
  };
}
