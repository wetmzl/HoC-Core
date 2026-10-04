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

  async seed(options: EmbeddedContentSeederOptions = {}): Promise<EmbeddedContentSeedResult> {
    await this.repository.open();
    if (!await this.repository.isEmpty()) return { seeded: false, packageCount: 0 };
    const packages = await this.source.packages();
    await this.repository.installBatch(packages, { onProgress: options.onProgress });
    return { seeded: true, packageCount: packages.length };
  }
}
