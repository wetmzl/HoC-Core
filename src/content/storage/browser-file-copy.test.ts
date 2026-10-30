import { describe, expect, it, vi } from "vitest";
import { copyBrowserFiles } from "./browser-file-copy";
import type { ContentDigest, ContentFileSource } from "./contracts";

function deferred() {
  let resolve!: (value: ContentDigest) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ContentDigest>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const digest = (index: number) => ({ bytes: index, sha256: String(index) });
const files = (count: number, kind: "asset" | "stored" = "asset") => Array.from({ length: count }, (_, index) => ({
  source: { kind, path: `input/${index}` } as ContentFileSource,
  destination: `output/${index}`
}));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("browser file copying", () => {
  it("overlaps at most four asset transfers and keeps digest order when completions are reordered", async () => {
    const pending = Array.from({ length: 7 }, deferred);
    const copy = vi.fn(file => pending[Number(file.destination.split("/").at(-1))]!.promise);
    const result = copyBrowserFiles(files(7), copy, () => {});
    expect(copy).toHaveBeenCalledTimes(4);
    pending[2]!.resolve(digest(2)); await flush();
    expect(copy).toHaveBeenCalledTimes(5);
    pending[0]!.resolve(digest(0)); await flush();
    expect(copy).toHaveBeenCalledTimes(6);
    pending[4]!.resolve(digest(4)); await flush();
    expect(copy).toHaveBeenCalledTimes(7);
    for (const index of [6, 5, 3, 1]) pending[index]!.resolve(digest(index));
    await expect(result).resolves.toEqual(Array.from({ length: 7 }, (_, index) => digest(index)));
  });

  it("stops scheduling on failure and waits for every active writer before rollback can begin", async () => {
    const pending = Array.from({ length: 6 }, deferred);
    const copy = vi.fn(file => pending[Number(file.destination.split("/").at(-1))]!.promise);
    let settled = false;
    const result = copyBrowserFiles(files(6), copy, () => {}).finally(() => { settled = true; });
    const rejected = expect(result).rejects.toThrow("download failed");
    pending[1]!.reject(new Error("download failed")); await flush();
    expect(settled).toBe(false);
    pending[0]!.resolve(digest(0)); pending[2]!.reject(new Error("second failure")); await flush();
    expect(settled).toBe(false);
    pending[3]!.resolve(digest(3));
    await rejected;
    expect(copy).toHaveBeenCalledTimes(4);
  });

  it("drains active transfers on cancellation and never starts queued files", async () => {
    const pending = Array.from({ length: 6 }, deferred);
    const controller = new AbortController();
    const copy = vi.fn(file => pending[Number(file.destination.split("/").at(-1))]!.promise);
    let settled = false;
    const result = copyBrowserFiles(files(6), copy, () => controller.signal.throwIfAborted()).finally(() => { settled = true; });
    const rejected = expect(result).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    pending[0]!.resolve(digest(0)); await flush();
    expect(settled).toBe(false);
    for (const index of [1, 2, 3]) pending[index]!.resolve(digest(index));
    await rejected;
    expect(copy).toHaveBeenCalledTimes(4);
  });

  it("keeps stored and mixed import sources serial", async () => {
    for (const entries of [files(3, "stored"), [files(1)[0]!, ...files(2, "stored")]]) {
      const pending = Array.from({ length: 3 }, deferred);
      const copy = vi.fn(() => pending[copy.mock.calls.length - 1]!.promise);
      const result = copyBrowserFiles(entries, copy, () => {});
      expect(copy).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 3; index++) {
        expect(copy).toHaveBeenCalledTimes(index + 1);
        pending[index]!.resolve(digest(index)); await flush();
      }
      await expect(result).resolves.toEqual([digest(0), digest(1), digest(2)]);
    }
  });
});
