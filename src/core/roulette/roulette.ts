import type { SeededRng, RngSnapshot } from "../rng/seeded";
import type { GunState, TriggerResult } from "./types";

export const DEFAULT_GUN_CAPACITY = 6;

export function createGun(capacity = DEFAULT_GUN_CAPACITY): GunState {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError("Gun capacity must be a positive integer");
  return { capacity, bullets: 0 };
}

export function addBullets(gun: GunState, amount: number): GunState {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("Bullet amount must be a non-negative integer");
  return { ...gun, bullets: Math.min(gun.capacity, gun.bullets + amount) };
}

export function removeBullets(gun: GunState, amount: number): GunState {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("Bullet amount must be a non-negative integer");
  return { ...gun, bullets: Math.max(0, gun.bullets - amount) };
}

export function deathProbability(gun: GunState): number {
  return gun.capacity === 0 ? 0 : gun.bullets / gun.capacity;
}

export function pullTrigger(gun: GunState, rng: SeededRng, misfireChance = 0): { result: TriggerResult; rng: RngSnapshot } {
  const baseProbability = deathProbability(gun);
  const effectiveMisfireChance = Math.max(0, Math.min(1, misfireChance));
  const probability = baseProbability * (1 - effectiveMisfireChance);
  const roll = rng.next();
  const result = roll < probability ? "fired" : roll < baseProbability ? "misfire" : "empty-chamber";
  return {
    result: { fired: result === "fired", result, probability, baseProbability, misfireChance: effectiveMisfireChance, gun },
    rng: rng.snapshot()
  };
}
