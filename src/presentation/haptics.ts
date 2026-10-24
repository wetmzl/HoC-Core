import type { MatchTransition } from "../runtime/match-transition";

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

/** Best-effort Android feedback; unsupported browsers simply do nothing. */
export function presentMatchHapticsTransition(
  { events }: MatchTransition,
  enabled: boolean,
  target: HapticsApi = haptics
): void {
  if (!enabled) return;
  if (events.some((event) => event.type === "ROUND_RESULT_ACKNOWLEDGED")) {
    void target.play([CONFIRM_PATTERN]);
    return;
  }
  const trigger = events.find((event) => event.type === "TRIGGER_PULLED");
  if (trigger?.type === "TRIGGER_PULLED") void target.play(trigger.fired ? GUNSHOT_PATTERN : DRY_FIRE_PATTERN);
}
