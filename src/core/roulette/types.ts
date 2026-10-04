export interface GunState {
  readonly capacity: number;
  readonly bullets: number;
}

export interface RouletteState {
  readonly player: GunState;
  readonly opponent: GunState;
}

export interface TriggerResult {
  readonly fired: boolean;
  readonly result: "fired" | "empty-chamber" | "misfire";
  readonly probability: number;
  readonly baseProbability: number;
  readonly misfireChance: number;
  readonly gun: GunState;
}
