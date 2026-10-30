import type { ContentDigest, ContentFileSource } from "./contracts";

interface CopyFile {
  readonly source: ContentFileSource;
  readonly destination: string;
}

/** Overlap embedded HTTP requests without buffering the entire package. */
export async function copyBrowserFiles(
  files: readonly CopyFile[],
  copy: (file: CopyFile) => Promise<ContentDigest>,
  check: () => void
): Promise<readonly ContentDigest[]> {
  // Local imports keep their existing single-file memory bound.
  const concurrency = files.every(file => file.source.kind === "asset") ? 4 : 1;
  const results: ContentDigest[] = new Array(files.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const run = async () => {
    while (!failed && next < files.length) {
      const index = next++;
      try {
        check();
        results[index] = await copy(files[index]!);
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  };
  // Drain active writes before rejecting: repository rollback must never race a writer.
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, run));
  if (failed) throw failure;
  check();
  return results;
}
