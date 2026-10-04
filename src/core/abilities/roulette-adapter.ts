import { addBullets, createGun } from "../roulette/roulette";
import type { GunState } from "../roulette/types";
import type { PendingLoad } from "./types";

export function clampLoadAmount(amount: number): number { return Math.max(0, Number.isFinite(amount) ? Math.floor(amount) : 0); }
export function gunBullets(gun: GunState): number { return gun.bullets; }
export function gunIsFull(gun: GunState): boolean { return gun.bullets >= gun.capacity; }
export function addGunBullets(gun: GunState, amount: number): GunState { return addBullets(gun, clampLoadAmount(amount)); }
export function addToPendingLoad(pending: PendingLoad, amount: number): PendingLoad { return { ...pending, amount: clampLoadAmount(pending.amount + amount) }; }
export function setPendingLoad(pending: PendingLoad, amount: number): PendingLoad { return { ...pending, amount: clampLoadAmount(amount) }; }
export function multiplyPendingLoad(pending: PendingLoad, factor: number): PendingLoad { return { ...pending, amount: clampLoadAmount(pending.amount * factor) }; }
export function commitPendingLoad(gun: GunState, pending: PendingLoad): GunState { return addBullets(gun, clampLoadAmount(pending.amount)); }
export { createGun };
