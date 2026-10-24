export function mediaType(path: string): string;
export function manifestFiles(directory: string): Promise<Array<{ path: string; bytes: number; sha256: string; mediaType: string }>>;
/** Returns whether content differs; check never writes source files. */
export function syncPackageIndex(directory: string, options?: { check?: boolean }): Promise<boolean>;
export function archiveFiles(files: Record<string, Uint8Array>): Promise<Uint8Array>;
