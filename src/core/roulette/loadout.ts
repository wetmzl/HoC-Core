import { createGun } from "./roulette";
import type { GunState } from "./types";

export const BOSS_GUN_CAPACITY = 8;
/** Configure both guns before opening abilities; guards keep their ordinary gun. */
export function encounterGuns(boss: boolean, carriedPlayer?: GunState) {
  return {
    ...(carriedPlayer ? { playerGun: { ...carriedPlayer } }
      : boss ? { playerGun: createGun(BOSS_GUN_CAPACITY) } : {}),
    ...(boss ? { opponentGun: createGun(BOSS_GUN_CAPACITY) } : {})
  };
}
