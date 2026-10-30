import { compileLegacyFlow } from "../../core/flow/program-templates";
import { legacyChallengeEncounter, type EncounterFlowResource } from "../encounter-flows/catalog";
import { stableJson } from "../storage/encoding";
import type { ContentRegistry, LoadedHocpkgPackage } from "./content-registry";
import type { CharacterMatchResource } from "./resources";

/** A character package may absorb its identical, formerly standalone encounter.
 * Keep the original IDs and stored snapshots; conflicting declarations still fail.
 */
export function resolveEncounterOwnership(packages: readonly LoadedHocpkgPackage[], registry: ContentRegistry) {
  const declarations = [
    ...registry.challenges.map(value => ({ value, entry: legacyChallengeEncounter(value) })),
    ...registry.encounterFlows.map(value => ({ value, entry: value }))
  ];
  const groups = new Map<string, typeof declarations>();
  for (const declaration of declarations) {
    const group = groups.get(declaration.entry.id) ?? [];
    group.push(declaration);
    groups.set(declaration.entry.id, group);
  }
  const retained = new Set<unknown>();
  const signature = (entry: EncounterFlowResource) => stableJson({
    ownerId: entry.ownerId, unlock: entry.unlock,
    entryVisible: entry.entryVisible ?? true, repeatable: entry.repeatable ?? false,
    program: entry.program ?? compileLegacyFlow(entry.definition), rematchSkills: entry.rematchSkills ?? []
  });
  for (const group of groups.values()) {
    if (group.length === 1) { retained.add(group[0].value); continue; }
    const owners = group.filter(declaration => packages.some(loaded =>
      loaded.resources.some(resource => resource.value === declaration.value)
      && loaded.resources.some(resource => resource.descriptor.type === "game.character-match"
        && (resource.value as CharacterMatchResource).metadata.id === declaration.entry.ownerId)));
    if (owners.length !== 1 || group.some(declaration => signature(declaration.entry) !== signature(owners[0].entry))) {
      throw new Error("Encounter flow identity is duplicated");
    }
    retained.add(owners[0].value);
  }
  return {
    challenges: registry.challenges.filter(entry => retained.has(entry)),
    encounterFlows: registry.encounterFlows.filter(entry => retained.has(entry))
  };
}
