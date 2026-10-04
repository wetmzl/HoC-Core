import {
  EmbeddedContentSeeder,
  EmbeddedContentSource,
  RepositoryContentSource,
  installContent,
  loadContent,
  type EmbeddedContentSourceOptions,
  type LoadedContent
} from "./packages";
import { createDefaultContentHostProviders } from "./storage/host-factory";
import { migrateBuiltinPackageAuthors } from "./storage/builtin-author-migration";
import { FileContentRepository } from "./storage/repository";
import { CONTENT_PERSISTENCE_REFUSED_WARNING, resolveContentHost, type ContentHostProvider, type ContentInstallProgress } from "./storage/contracts";

export interface ContentStartupProgress extends ContentInstallProgress {
  readonly phase: "seeding";
}

export interface ContentStartupOptions {
  readonly providers?: readonly ContentHostProvider[];
  readonly embedded?: EmbeddedContentSourceOptions;
  readonly onProgress?: (progress: ContentStartupProgress) => void;
}

export interface ContentStartupResult {
  readonly content: LoadedContent;
  readonly source: "repository" | "embedded";
  readonly repositoryError?: unknown;
  readonly warnings: readonly string[];
}

export async function startContent(options: ContentStartupOptions = {}): Promise<ContentStartupResult> {
  const embedded = new EmbeddedContentSource(options.embedded);
  let repositoryError: unknown;
  const warnings: string[] = [];
  try {
    const host = await resolveContentHost(options.providers ?? createDefaultContentHostProviders());
    if (!host) throw new Error("当前宿主没有可用的持久化内容目录。");
    const repository = new FileContentRepository(host);
    await repository.open();
    const index = await embedded.loadIndex();
    if (await repository.isEmpty()) {
      const requiredBytes = index.packages.reduce((total, entry) => total + entry.bytes, 0);
      const availableBytes = await host.capabilities.estimateAvailableBytes?.();
      if (availableBytes !== undefined && availableBytes !== null && availableBytes < requiredBytes) {
        throw new Error(`内容目录空间不足：需要 ${requiredBytes} 字节，可用 ${availableBytes} 字节。`);
      }
      const persistent = await host.capabilities.requestPersistence?.();
      if (persistent === false) warnings.push(CONTENT_PERSISTENCE_REFUSED_WARNING);
      await new EmbeddedContentSeeder(repository, embedded).seed({
        onProgress: (progress) => options.onProgress?.({ phase: "seeding", ...progress })
      });
    }
    await migrateBuiltinPackageAuthors(repository);
    const content = await loadContent(new RepositoryContentSource(repository), index);
    installContent(content);
    return { content, source: "repository", warnings };
  } catch (error) {
    repositoryError = error;
  }

  try {
    const index = await embedded.loadIndex();
    const content = await loadContent(embedded, index);
    installContent(content);
    return { content, source: "embedded", repositoryError, warnings };
  } catch (embeddedError) {
    throw new AggregateError([repositoryError, embeddedError], "持久化内容仓库与内嵌恢复源均无法启动。", { cause: embeddedError });
  }
}
