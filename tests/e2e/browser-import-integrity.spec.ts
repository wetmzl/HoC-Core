import { expect, test } from "@playwright/test";

test("真实 Worker 复制失败、落盘损坏和取消后保留旧包，清理候选并允许重试", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { OpfsContentHostProvider } = await load("/src/content/storage/opfs-host.ts");
    const { FileContentRepository } = await load("/src/content/storage/repository.ts");
    const { sha256 } = await load("/src/content/storage/encoding.ts");
    const host = await new OpfsContentHostProvider().open(), fs = host.fileSystem;
    const repository = new FileContentRepository(host);
    const source = async (packageName: string, version: string) => {
      const files = [];
      for (const name of ["one", "two"]) {
        const path = `resources/shared/${name}.json`, input = `integrity-input/${packageName}/${version}/${name}.json`;
        const bytes = new TextEncoder().encode(JSON.stringify({ version, name }));
        await fs.write(input, bytes);
        files.push({ path, input, bytes: bytes.length, sha256: await sha256(bytes), mediaType: "application/json" });
      }
      return {
        manifest: {
          format: "house-of-chances-hocpkg", formatVersion: 1,
          identity: { authorId: "integrity", packageName, version },
          metadata: { title: "完整性验证", description: "中性测试包", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
          resources: [{ id: "data", type: "test.data", apiVersion: 1, entry: files[0]!.path, requires: [] }],
          files: files.map(({ input: _input, ...entry }) => entry), extensions: {}
        },
        async *files() { for (const file of files) yield { path: file.path, source: { kind: "stored", path: file.input } }; }
      };
    };
    await repository.install(await source("update", "1.0.0"));
    const before = await repository.listPackages();
    const oldFiles = await fs.list("content/v1/revisions");
    const batch = [await source("new", "1.0.0"), await source("update", "2.0.0")];
    const copyMany = fs.copyMany.bind(fs);
    const failures = [];
    for (const fault of ["write", "corrupt", "cancel"]) {
      const abort = new AbortController();
      let calls = 0, error = "";
      fs.copyMany = async (files: { destination: string }[], options: unknown) => {
        const digests = await copyMany(files, options);
        if (++calls === 2) {
          if (fault === "write") throw new DOMException("injected disk full", "QuotaExceededError");
          if (fault === "corrupt") await fs.write(files[1]!.destination, new TextEncoder().encode("tampered"));
          if (fault === "cancel") abort.abort(new Error("injected cancellation"));
        }
        return digests;
      };
      try { await repository.installBatch(batch, { signal: abort.signal }); }
      catch (caught) { error = String(caught); }
      finally { fs.copyMany = copyMany; }
      const filesAfterFailure = await fs.list("content/v1/revisions");
      const reopened = new FileContentRepository(host);
      await reopened.verifyPackage("integrity/update");
      failures.push({ fault, error, catalogUnchanged: JSON.stringify(await reopened.listPackages()) === JSON.stringify(before),
        filesUnchanged: JSON.stringify(filesAfterFailure) === JSON.stringify(oldFiles), calls });
    }
    await repository.installBatch(batch);
    const reopened = new FileContentRepository(host);
    await reopened.verifyPackage("integrity/update");
    await reopened.verifyPackage("integrity/new");
    return { failures, version: (await reopened.readManifest("integrity/update")).identity.version,
      pending: (await fs.list("content/v1/revisions")).filter((path: string) => path.endsWith("/.pending")) };
  });
  expect(result.failures).toHaveLength(3);
  for (const failure of result.failures) {
    expect(failure).toMatchObject({ catalogUnchanged: true, filesUnchanged: true, calls: 2 });
    expect(failure.error).toMatch(/disk full|落盘文件复验失败|cancellation/);
  }
  expect(result.version).toBe("2.0.0");
  expect(result.pending).toEqual([]);
});
