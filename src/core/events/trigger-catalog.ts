/** Shared synchronous rule window names. Existing content names remain unchanged. */
export const ABILITY_TRIGGER_TYPES = [
  "before-round-deal", "on-round-start", "before-bust-resolution", "on-match-created", "on-ability-gained", "on-ability-played",
  "before-turn", "before-ai-decision", "before-card-draw", "after-card-draw", "after-draw-pile-changed", "after-card-acquired",
  "after-hit-resolved", "after-hand-changed", "after-stand", "before-bust-check", "before-round-resolution", "before-bullet-load",
  "after-bullet-load", "before-trigger-pull", "after-trigger-result", "before-defeat", "after-defeat-prevented", "on-round-end"
] as const;
export const ABILITY_BROADCAST_TRIGGER_TYPES = [...ABILITY_TRIGGER_TYPES, "after-ability-played"] as const;
