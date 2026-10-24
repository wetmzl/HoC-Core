import { CORE_PACKAGE_AUTHOR_ID, CORE_PACKAGE_AUTHOR_NAME, LEGACY_BUILTIN_PACKAGE_IDS } from "../packages/builtin-authors";
import type { FileContentRepository } from "./repository";

/** Change only package ownership, preserving installed versions, bytes and enable state. */
export async function migrateBuiltinPackageAuthors(repository: FileContentRepository): Promise<void> {
  const installed = new Set((await repository.listPackages()).map((entry) => entry.packageId));
  for (const oldId of Object.keys(LEGACY_BUILTIN_PACKAGE_IDS)) {
    if (!installed.has(oldId)) continue;
    const manifest = await repository.readManifest(oldId);
    await repository.reidentifyPackage(oldId, {
      ...manifest,
      identity: { ...manifest.identity, authorId: CORE_PACKAGE_AUTHOR_ID },
      metadata: { ...manifest.metadata, creators: [{ displayName: CORE_PACKAGE_AUTHOR_NAME, roles: ["maintainer"] }] }
    });
  }
}
