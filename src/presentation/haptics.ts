import type { MatchState } from "../core/match/types";

import { haptics, type HapticsApi } from "./haptic-service";

const CONFIRM_PATTERN = 18;
const DRY_FIRE_PATTERN = [22, 35, 28];
const GUNSHOT_PATTERN = [70, 30, 120];
const INTERACTION_PATTERN = 8;

function vibrate(enabled: boolean, pattern: number | number[], target: HapticsApi): void {
  if (enabled) void target.play(typeof pattern === "number" ? [pattern] : pattern);
}

/** Gives an enabled UI button the lightest available best-effort click feedback. */
export function presentInteractionHaptic(
  enabled: boolean,
  target: HapticsApi = haptics
): void {
  vibrate(enabled, INTERACTION_PATTERN, target);
}

/** Uses the dry-fire strength for a committed archetype selection change. */
export function presentSkillSelectionHaptic(
  enabled: boolean,
  target: HapticsApi = haptics
): void {
  vibrate(enabled, DRY_FIRE_PATTERN, target);
}

/** Best-effort Android feedback; unsupported browsers simply do nothing. */
export function presentMatchHaptics(
  before: MatchState,
  after: MatchState,
  enabled: boolean,
  target: HapticsApi = haptics
): void {
  if (!enabled) return;
  const events = after.history.slice(before.history.length);
  if (events.some((event) => event.type === "ROUND_RESULT_ACKNOWLEDGED")) {
    void target.play([CONFIRM_PATTERN]);
    return;
  }
  const trigger = events.find((event) => event.type === "TRIGGER_PULLED");
  if (trigger?.type === "TRIGGER_PULLED") void target.play(trigger.fired ? GUNSHOT_PATTERN : DRY_FIRE_PATTERN);
}
