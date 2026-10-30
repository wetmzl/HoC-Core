import { compareHocpkgVersions } from "./package-state";
import type { ContentInstallProgress, ContentRepository } from "../storage/contracts";
import type { ContentSource } from "./content-source";

export interface EmbeddedContentSeedResult {
  readonly seeded: boolean;
  readonly packageCount: number;
}

export interface EmbeddedContentSeederOptions {
  readonly onProgress?: (progress: ContentInstallProgress) => void;
}

export class EmbeddedContentSeeder {
  constructor(
    private readonly repository: ContentRepository,
    private readonly source: ContentSource
  ) {}

  /** Upgrade only installed embedded identities; keep disabled/missing/external packages as chosen. */
  async upgradeInstalled(options: EmbeddedContentSeederOptions = {}): Promise<{ upgraded: number }> {
    await this.repository.open();
    const installed = new Set((await this.repository.listPackages()).map(entry => entry.packageId));
    const updates = [];
    for (const candidate of await this.source.packages()) {
      if (!installed.has(candidate.packageId)) continue;
      let current;
      try { current = await this.repository.readManifest(candidate.packageId); } catch { continue; }
      if (compareHocpkgVersions(candidate.manifest.identity.version, current.identity.version) > 0) updates.push(candidate);
    }
    if (updates.length) await this.repository.installBatch(updates, { onProgress: options.onProgress });
    return { upgraded: updates.length };
  }

  async seed(options: EmbeddedContentSeederOptions = {}): Promise<EmbeddedContentSeedResult> {
    await this.repository.open();
    if (!await this.repository.isEmpty()) return { seeded: false, packageCount: 0 };
    const packages = await this.source.packages();
    await this.repository.installBatch(packages, { onProgress: options.onProgress });
    return { seeded: true, packageCount: packages.length };
  }
}
