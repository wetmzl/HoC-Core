import type {
  ContentAssetResolver,
  ContentFileSystem,
  ContentHost,
  ContentHostProvider,
  ContentStorageCapabilities,
  ResolvedContentAsset
} from "./contracts";

type MemoryOperation = "read" | "write" | "list" | "remove";

interface MemoryFault {
  readonly operation: MemoryOperation;
  readonly pattern?: RegExp;
  remainingMatches: number;
}

function copy(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

export class MemoryContentFileSystem implements ContentFileSystem {
  readonly entries = new Map<string, Uint8Array>();
  private readonly faults: MemoryFault[] = [];

  failNext(operation: MemoryOperation, pattern?: RegExp, afterMatches = 0): void {
    this.faults.push({ operation, pattern, remainingMatches: afterMatches });
  }

  private fault(operation: MemoryOperation, path: string): void {
    const index = this.faults.findIndex((candidate) => candidate.operation === operation && (!candidate.pattern || candidate.pattern.test(path)));
    if (index < 0) return;
    const selected = this.faults[index]!;
    if (selected.remainingMatches > 0) {
      selected.remainingMatches -= 1;
      return;
    }
    this.faults.splice(index, 1);
    throw new Error(`MemoryContentFileSystem injected ${operation} failure: ${path}`);
  }

  async read(path: string): Promise<Uint8Array | null> {
    this.fault("read", path);
    const value = this.entries.get(path);
    return value ? copy(value) : null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.fault("write", path);
    this.entries.set(path, copy(bytes));
  }

  async list(prefix: string): Promise<readonly string[]> {
    this.fault("list", prefix);
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return [...this.entries.keys()].filter((path) => path.startsWith(normalized)).sort();
  }

  async remove(path: string): Promise<void> {
    this.fault("remove", path);
    this.entries.delete(path);
    const normalized = path.endsWith("/") ? path : `${path}/`;
    for (const entry of this.entries.keys()) if (entry.startsWith(normalized)) this.entries.delete(entry);
  }
}

export class MemoryContentAssetResolver implements ContentAssetResolver {
  readonly resolved: string[] = [];

  async resolve(path: string, _mediaType: string): Promise<ResolvedContentAsset> {
    this.resolved.push(path);
    return { url: `memory-content://${path}` };
  }
}

const capabilities: ContentStorageCapabilities = {
  persistent: false,
  canEstimateSpace: false,
  canRequestPersistence: false
};

export class MemoryContentHostProvider implements ContentHostProvider {
  readonly id = "memory";
  readonly fileSystem: MemoryContentFileSystem;
  readonly assetResolver: MemoryContentAssetResolver;
  readonly host: ContentHost;

  constructor(fileSystem = new MemoryContentFileSystem()) {
    this.fileSystem = fileSystem;
    this.assetResolver = new MemoryContentAssetResolver();
    this.host = { fileSystem, assetResolver: this.assetResolver, capabilities };
  }

  async probe(): Promise<boolean> { return true; }
  async open(): Promise<ContentHost> { return this.host; }
}
