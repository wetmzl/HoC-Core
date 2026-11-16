import { describe, expect, it, vi } from "vitest";
import { importPasswordCandidates } from "../storage/password-book";
import { unzipSync } from "fflate";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { FileContentRepository } from "../storage/repository";
import { HocpkgTransfer } from "./hocpkg";
import { encryptedZip, neutralPackage, nestedFixture } from "../../../tests/fixtures/encrypted-bundles";
import type { ArchivePasswordRequest } from "../storage/contracts";

function setup() {
  const host = new MemoryContentHostProvider();
  const repository = new FileContentRepository(host.host);
  return { host, repository, transfer: new HocpkgTransfer(host.fileSystem, repository) };
}
const file = (bytes: Uint8Array) => new File([new Uint8Array(bytes)], "renamed.dat");
describe("encrypted content imports", () => {
  it("automatically unlocks the built-in password even with existing unrelated personal passwords", async () => {
    const { transfer } = setup();
    const requestPassword = vi.fn();
    const session = await transfer.stage(file(await encryptedZip({ "builtin.hocpkg": neutralPackage("builtin") }, "welcome2hoc")),
      { passwords: importPasswordCandidates(["personal-password"]), requestPassword });
    expect(session.candidates[0]?.packageId).toBe("zip-test/builtin");
    expect(session.candidates[0]?.error).toBeUndefined();
    expect(requestPassword).not.toHaveBeenCalled();
  });
  it("tries the book, retries a wrong manual password, skips unknown branches and installs verified siblings", async () => {
    const { host, repository, transfer } = setup();
    const requested: ArchivePasswordRequest[] = [];
    const remember = vi.fn();
    let manualAttempts = 0;
    const session = await transfer.stage(file(await nestedFixture()), { passwords: ["wrong", "outer-key", "book-key"], rememberPassword: remember,
      requestPassword: async request => {
        requested.push(request);
        if (request.source.endsWith("manual.zip")) return { password: ++manualAttempts === 1 ? "wrong-manual" : "manual-key", remember: true };
        return null;
      } });
    expect(session.candidates.filter(item => !item.error).map(item => item.packageId)).toEqual(["zip-test/known", "zip-test/manual", "zip-test/plain"]);
    expect(session.candidates.filter(item => item.error)).toHaveLength(2);
    expect(requested.map(item => item.source.split("/").at(-1))).toEqual(["manual.zip", "manual.zip", "missing-a.zip", "missing-b.zip"]);
    expect(requested.every(item => item.failed)).toBe(true);
    expect(remember).toHaveBeenCalledExactlyOnceWith("manual-key");
    for (const path of await host.fileSystem.list("content/v1/imports")) {
      if (path.endsWith("session.json")) expect(new TextDecoder().decode(await host.fileSystem.read(path) ?? undefined)).not.toContain("manual-key");
    }
    await transfer.installSelected(session.id, session.candidates.filter(item => !item.error).map(item => item.id));
    expect((await repository.listPackages()).map(item => item.packageId)).toEqual(["zip-test/known", "zip-test/manual", "zip-test/plain"]);
  });
  it.each([true, false])("decodes an encrypted hocpkg with a changed extension (ZipCrypto=%s)", async zipCrypto => {
    const { transfer } = setup();
    const requestPassword = vi.fn();
    const session = await transfer.stage(file(await encryptedZip(unzipSync(neutralPackage("encrypted")), "test-key", zipCrypto)), { passwords: ["wrong", "test-key"], requestPassword });
    expect(session.candidates[0]?.packageId).toBe("zip-test/encrypted");
    expect(session.candidates[0]?.error).toBeUndefined();
    expect(requestPassword).not.toHaveBeenCalled();
  });
  it("cleans all staged data when cancelled while waiting for a password", async () => {
    const { host, transfer } = setup();
    const abort = new AbortController();
    await expect(transfer.stage(file(await nestedFixture()), { passwords: ["outer-key", "book-key"], signal: abort.signal,
      requestPassword: async () => { abort.abort(); return null; } })).rejects.toThrow();
    expect(await host.fileSystem.list("content/v1/imports")).toEqual([]);
  });
  it("does not ask for a password on a damaged plain ZIP", async () => {
    const { transfer } = setup();
    const requestPassword = vi.fn();
    const session = await transfer.stage(file(Uint8Array.of(80, 75, 3, 4)), { requestPassword });
    expect(session.candidates[0]?.error).toContain("中央目录");
    expect(requestPassword).not.toHaveBeenCalled();
  });
});
