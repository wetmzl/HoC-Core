import type { MatchState } from "../match/types";
import type { PlayerSkillInventory } from "../skills/types";
import type { AbilityInstance, AbilityRuntimeState } from "./types";
import type { RngSnapshot } from "../rng/seeded";
import { addAbilityInstance } from "./runtime";

/** Only the challenge inventory survives a table; its acquisition budgets span the challenge. */
export interface PlayerSkillCarryover {
  readonly inventory: Omit<PlayerSkillInventory, "drawOffer">;
  readonly instances: readonly AbilityInstance[];
  readonly counters: AbilityRuntimeState["counters"];
  readonly sequence: number;
  readonly rng: RngSnapshot;
  readonly lootRng: RngSnapshot;
  readonly lastPlayedPlayerSkillDefinitionId: string | null;
  readonly lastPlayedPlayerSkillLevel: number;
}
export function capturePlayerSkills(source: MatchState): PlayerSkillCarryover {
  const { drawOffer: _offer, ...inventory } = source.playerSkills;
  const ids = new Set(inventory.cards.map(card => card.instanceId));
  return {
    inventory, instances: source.abilities.instances.filter(instance => ids.has(instance.instanceId)),
    // A new table resets turn/round restrictions; per-card match budgets span the challenge.
    counters: Object.fromEntries(Object.entries(source.abilities.counters).filter(([key]) => key.endsWith(":match") && [...ids].some(id => key.startsWith(`${id}:`)))),
    sequence: source.abilities.sequence, rng: source.abilities.rng, lootRng: source.rng.loot,
    lastPlayedPlayerSkillDefinitionId: source.abilities.lastPlayedPlayerSkillDefinitionId,
    lastPlayedPlayerSkillLevel: source.abilities.lastPlayedPlayerSkillLevel ?? 1
  };
}
/** Used before opening events of a fresh table, without granting cards or uses again. */
export function carryPlayerSkills(target: MatchState, source: PlayerSkillCarryover): MatchState {
  let runtime: AbilityRuntimeState = { ...target.abilities, sequence: Math.max(target.abilities.sequence, source.sequence),
    rng: source.rng, counters: { ...target.abilities.counters, ...source.counters },
    lastPlayedPlayerSkillDefinitionId: source.lastPlayedPlayerSkillDefinitionId,
    lastPlayedPlayerSkillLevel: source.lastPlayedPlayerSkillLevel };
  for (const instance of source.instances) runtime = addAbilityInstance(runtime, instance);
  return { ...target, playerSkills: { ...source.inventory, drawOffer: null }, abilities: runtime,
    rng: { ...target.rng, loot: source.lootRng } };
}
