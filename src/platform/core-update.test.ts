import { describe, expect, it, vi } from "vitest";
import { CoreUpdater, type CoreRelease, type CoreUpdatePort, type CoreUpdateUI } from "./core-update";
const release: CoreRelease = { version: "1.0.0", tag: "v1.0.0", notes: "更新说明", bytes: 1024, sha256: "a".repeat(64) };
function fixture() {
  let time = 1_000_000;
  let ready: CoreRelease | undefined;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const port = {
    networkStatus: vi.fn(async () => ({ connected: true, wifi: true })),
    getStatus: vi.fn(async () => ({ supported: true, currentVersion: "0.2.0-beta2", currentVersionCode: 5, canInstall: true, ready })),
    check: vi.fn<CoreUpdatePort['check']>(async () => ({ state: "available", release })),
    releaseNotes: vi.fn(async () => ({ feed: "invalid" })),
    download: vi.fn(async () => { ready = release; return release; }), cancel: vi.fn(), install: vi.fn(), addListener: vi.fn()
  } satisfies CoreUpdatePort;
  const ui = { offer: vi.fn<CoreUpdateUI["offer"]>(async () => "later"), notice: vi.fn<CoreUpdateUI["notice"]>(async () => {}), install: vi.fn<CoreUpdateUI["install"]>(async () => {}) };
  const updater = new CoreUpdater(port, ui, true, storage, () => time);
  return { updater, port, ui, storage, setReady: (value: CoreRelease) => { ready = value; }, advance: (ms: number) => { time += ms; } };
}
describe("download before prompting", () => {
  it("defaults to Wi-Fi, verifies readiness before offering and immediately delegates consent to native installation", async () => {
    const { updater, port, ui } = fixture();
    ui.offer.mockImplementation(async () => { expect(port.getStatus).toHaveBeenCalledTimes(2); return "update"; });
    expect(updater.getAutoDownload()).toBe("wifi");
    await updater.check(false);
    expect(port.download).toHaveBeenCalledWith({ tag: release.tag, channel: "stable" });
    expect(ui.install).toHaveBeenCalledWith(release, expect.any(Object), true);
  });
  it.each(["cellular", "offline", "unknown", "never"])("keeps %s checks quiet without automatic downloads", async network => {
    const { updater, port, ui } = fixture();
    port.networkStatus.mockResolvedValue({ connected: network !== "offline", wifi: false });
    if (network === "never") updater.setAutoDownload("never");
    if (network === "unknown") port.networkStatus.mockRejectedValue(Error("unknown"));
    await updater.check(false);
    expect(port.download).not.toHaveBeenCalled(); expect(ui.offer).not.toHaveBeenCalled();
  });
  it("reconfirms a restored package after restarting inside the metadata cooldown", async () => {
    const { updater, port, ui, storage } = fixture();
    await updater.download();
    const restarted = new CoreUpdater(port, ui, true, storage, () => 1_000_001);
    await restarted.check(false);
    expect(ui.offer).toHaveBeenCalledOnce();
    expect(port.download).toHaveBeenCalledOnce();
    expect(port.check).toHaveBeenCalledTimes(2);
  });
  it("allows always on cellular and persists the preference", async () => {
    const { updater, port, ui, storage } = fixture();
    port.networkStatus.mockResolvedValue({ connected: true, wifi: false });
    updater.setAutoDownload("always"); await updater.check(false);
    expect(port.download).toHaveBeenCalledOnce();
    expect(new CoreUpdater(port, ui, true, storage).getAutoDownload()).toBe("always");
  });
  it("downloads on Wi-Fi reconnection without waiting for the metadata cooldown", async () => {
    const { updater, port, ui } = fixture();
    port.networkStatus.mockResolvedValueOnce({ connected: true, wifi: false });
    await updater.check(false); await updater.check(false);
    expect(port.check).toHaveBeenCalledOnce(); expect(ui.offer).toHaveBeenCalledOnce();
  });
  it("never prompts on failed or unverified downloads and backs off retries", async () => {
    const { updater, port, ui, advance } = fixture();
    port.download.mockRejectedValue(Error("断网")); await updater.check(false); await updater.check(false);
    expect(port.download).toHaveBeenCalledOnce(); expect(ui.offer).not.toHaveBeenCalled();
    advance(3600_001); port.download.mockResolvedValue(release); await updater.check(false);
    expect(ui.offer).not.toHaveBeenCalled();
  });
  it("suppresses a skipped version across restarts but checks the next release", async () => {
    const { updater, port, ui, storage, advance } = fixture(); ui.offer.mockResolvedValue("skip");
    await updater.check(false);
    const restarted = new CoreUpdater(port, ui, true, storage, () => 1000_001);
    await restarted.check(false); expect(ui.offer).toHaveBeenCalledOnce();
    advance(86400_001);
    const next = { ...release, version: "1.1.0", tag: "v1.1.0", sha256: "b".repeat(64) };
    port.check.mockResolvedValue({ state: "available", release: next });
    port.download.mockImplementation(async () => { port.getStatus.mockResolvedValue({ supported: true, currentVersion: "0.2", currentVersionCode: 5, canInstall: true, ready: next }); return next; });
    await updater.check(false); expect(ui.offer).toHaveBeenLastCalledWith(next, expect.any(String));
  });
  it("defers reminders for 24 hours and allows manual installation in between", async () => {
    const { updater, ui, advance } = fixture();
    await updater.check(false); await updater.check(false); expect(ui.offer).toHaveBeenCalledOnce();
    await updater.install(); expect(ui.install).toHaveBeenCalledOnce();
    advance(86400_001); await updater.check(false); expect(ui.offer).toHaveBeenCalledTimes(2);
  });
  it("keeps manual check, download and installation separate even with auto download disabled", async () => {
    const { updater, port, ui } = fixture(); updater.setAutoDownload("never");
    await updater.check(true); expect(port.download).not.toHaveBeenCalled();
    await updater.install(); expect(ui.install).not.toHaveBeenCalled();
    await updater.download(); expect(port.download).toHaveBeenCalledOnce(); expect(ui.install).not.toHaveBeenCalled();
    await updater.install(); expect(ui.install).toHaveBeenCalledOnce(); expect(ui.offer).not.toHaveBeenCalled();
  });
  it("rechecks the source before installing a cached package and rejects an outdated ready version", async () => {
    const { updater, port, ui, setReady } = fixture(); setReady(release);
    port.check.mockResolvedValue({ state: "available", release: { ...release, tag: "v2.0.0" } });
    await updater.install(); expect(ui.install).not.toHaveBeenCalled();
  });
  it("downloads in background but defers the prompt while a game is running", async () => {
    const { updater, port, ui } = fixture(); let safe = true;
    const download = port.download.getMockImplementation()!;
    port.download.mockImplementation(async () => { const result = await download(); safe = false; return result; });
    await updater.check(false, () => safe); expect(ui.offer).not.toHaveBeenCalled();
    safe = true; await updater.check(false, () => safe); expect(ui.offer).toHaveBeenCalledOnce();
  });
  it("keeps stable without silently falling back to prereleases", async () => {
    const { updater, port, ui } = fixture(); port.check.mockResolvedValue({ state: "no-release" });
    await updater.check(false); expect(ui.notice).not.toHaveBeenCalled();
    await updater.check(true); expect(ui.notice.mock.calls[0][1]).toContain("暂无稳定版");
  });
  it("ignores stale replies after switching channels", async () => {
    const { updater, port, ui } = fixture();
    port.check.mockImplementation(async () => { updater.setChannel("latest"); return { state: "available", release }; });
    await updater.download(); expect(port.download).not.toHaveBeenCalled(); expect(ui.notice).not.toHaveBeenCalled();
  });
  it("binds checks and downloads to selected channels", async () => {
    const { updater, port } = fixture(); updater.setChannel("latest"); await updater.download();
    expect(port.check).toHaveBeenCalledWith({ channel: "latest" }); expect(port.download).toHaveBeenCalledWith({ tag: release.tag, channel: "latest" });
  });
  it("serializes clicks and ignores unsupported application identities", async () => {
    const { updater, port, ui } = fixture();
    await Promise.all([updater.check(true), updater.download()]); expect(port.check).toHaveBeenCalledOnce();
    port.getStatus.mockResolvedValue({ supported: false } as never); await updater.download();
    expect(port.download).not.toHaveBeenCalled(); expect(ui.notice.mock.calls.at(-1)?.[1]).toContain("独立应用身份");
  });
  it("only reads fallback release notes for manual rate-limit failures", async () => {
    const { updater, port, ui } = fixture(); const error = "GitHub 暂时限制了检查频率";
    port.check.mockRejectedValue(Error(error)); await updater.check(false); expect(port.releaseNotes).not.toHaveBeenCalled();
    await updater.check(true); expect(port.releaseNotes).toHaveBeenCalledOnce(); expect(ui.notice).toHaveBeenLastCalledWith("更新未完成", error);
  });
});
