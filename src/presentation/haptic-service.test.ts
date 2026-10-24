import { afterEach, describe, expect, it, vi } from "vitest";
import { HapticService, createHapticDriver, validHapticPattern, bindHapticLifecycle } from "./haptic-service";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(), getState: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const driver = { play: vi.fn(async (_pattern: readonly number[]): Promise<void> => undefined), cancel: vi.fn(async () => undefined) };
  const service = new HapticService(driver);
  service.configure(true);
  return { service, driver };
}
describe("portable haptic service", () => {
  it("selects the native bridge on Android and the web adapter otherwise", async () => {
    const native = { play: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
    const web = { vibrate: vi.fn(() => true) };
    const android = createHapticDriver("android", native, web);
    await android.play([25, 75, 25]); await android.cancel();
    expect(native.play).toHaveBeenCalledWith({ pattern: [25, 75, 25] });
    expect(native.cancel).toHaveBeenCalledOnce(); expect(web.vibrate).not.toHaveBeenCalled();
    const browser = createHapticDriver("web", native, web);
    browser.play([8]); browser.cancel();
    expect(web.vibrate.mock.calls).toEqual([[[8]], [0]]);
    expect(() => createHapticDriver("web", native, {}).play([8])).not.toThrow();
  });
  it("validates the same finite nonnegative waveform contract as Android", () => {
    for (const value of [[], [-1], [0.1], [NaN], [Infinity], [5000, 5001], Array(65).fill(1)]) expect(validHapticPattern(value)).toBe(false);
    for (const value of [[0], [10000], Array(64).fill(1), [25, 75, 25, 75]]) expect(validHapticPattern(value)).toBe(true);
  });
  it("supersedes queued requests and ignores cancellation of an old owner", async () => {
    const { service, driver } = fixture();
    const old = new AbortController(); const next = new AbortController();
    const pending = service.play([8], { signal: old.signal });
    await service.play([25, 75, 25], { signal: next.signal }); await pending;
    old.abort();
    expect(driver.play.mock.calls).toEqual([[[25, 75, 25]]]);
    expect(driver.cancel).toHaveBeenCalledTimes(1);
    next.abort(); await service.stop();
    expect(driver.cancel).toHaveBeenCalledTimes(3);
  });
  it("serializes in-flight native play before cancellation", async () => {
    const { service, driver } = fixture();
    let complete!: () => void;
    driver.play.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const play = service.play([500]);
    await vi.waitFor(() => expect(driver.play).toHaveBeenCalledOnce());
    const stopped = service.stop();
    expect(driver.cancel).toHaveBeenCalledTimes(1);
    complete(); await play; await stopped;
    expect(driver.cancel).toHaveBeenCalledTimes(2);
  });
  it("cancels disabled and background feedback, without reviving an old sequence", async () => {
    const { service, driver } = fixture();
    await service.play([20]); service.configure(false); await service.play([30]);
    service.configure(true); service.setForeground("document", false); await service.play([40]);
    service.setForeground("native", false); service.setForeground("document", true); await service.play([50]);
    service.setForeground("native", true); await service.play([60]);
    expect(driver.play.mock.calls).toEqual([[[20]], [[60]]]);
  });
  it("contains rejected bridge calls and ignores invalid or aborted requests", async () => {
    const { service, driver } = fixture();
    driver.play.mockRejectedValueOnce(new Error("unavailable"));
    await expect(service.play([8])).resolves.toBeUndefined();
    const controller = new AbortController(); controller.abort();
    await service.play([8], { signal: controller.signal }); await service.play([-1]);
    await service.play([10]);
    expect(driver.play).toHaveBeenCalledTimes(2);
  });
  it("binds visibility, native activity and disposal without retaining listeners", async () => {
    const { service, driver } = fixture();
    const document = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", document);
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    let onActivity!: (state: { isActive: boolean }) => void;
    const remove = vi.fn(async () => undefined);
    vi.mocked(App.addListener).mockImplementation(async (_event: string, listener: any) => { onActivity = listener; return { remove }; });
    vi.mocked(App.getState).mockResolvedValue({ isActive: true });
    const dispose = await bindHapticLifecycle(service);
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); await service.play([8]);
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
    onActivity({ isActive: false }); await service.play([9]);
    onActivity({ isActive: true }); await service.play([10]);
    await dispose(); await service.play([11]);
    expect(driver.play.mock.calls).toEqual([[[10]]]); expect(remove).toHaveBeenCalledOnce();
  });
});
