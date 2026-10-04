import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";

export interface HapticOptions { readonly signal?: AbortSignal }
export interface HapticsApi { play(pattern: readonly number[], options?: HapticOptions): Promise<void> }
export interface HapticDriver {
  play(pattern: readonly number[]): void | Promise<void>;
  cancel(): void | Promise<void>;
}
export function validHapticPattern(pattern: readonly number[]): boolean {
  return Array.isArray(pattern) && pattern.length > 0 && pattern.length <= 64
    && pattern.every((value) => Number.isSafeInteger(value) && value >= 0)
    && pattern.reduce((sum, value) => sum + value, 0) <= 10_000;
}
interface NativeHaptics { play(options: { pattern: number[] }): Promise<void>; cancel(): Promise<void> }
const nativeHaptics = registerPlugin<NativeHaptics>("HocHaptics");
export function createHapticDriver(
  platform = Capacitor.getPlatform(),
  native: NativeHaptics = nativeHaptics,
  web: { vibrate?: (pattern: number | number[]) => boolean } = typeof navigator === "undefined" ? {} : navigator
): HapticDriver {
  if (platform === "android") return { play: (pattern) => native.play({ pattern: [...pattern] }), cancel: () => native.cancel() };
  return { play: (pattern) => { web.vibrate?.([...pattern]); }, cancel: () => { web.vibrate?.(0); } };
}

/** Serializes device commands and keeps cancellation owned by the originating request. */
export class HapticService implements HapticsApi {
  private enabled = false;
  private readonly suspended = new Set<string>();
  private generation = 0;
  private pending = Promise.resolve();
  private detachAbort?: () => void;
  constructor(private readonly driver: HapticDriver = createHapticDriver()) {}
  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) void this.stop();
  }
  setForeground(source: string, active: boolean): void {
    if (active) this.suspended.delete(source);
    else { this.suspended.add(source); void this.stop(); }
  }
  private enqueue(action: () => void | Promise<void>): Promise<void> {
    this.pending = this.pending.then(action).catch(() => { /* Feedback must never block game actions. */ });
    return this.pending;
  }
  play(pattern: readonly number[], options: HapticOptions = {}): Promise<void> {
    if (!this.enabled || this.suspended.size || options.signal?.aborted || !validHapticPattern(pattern)) return Promise.resolve();
    this.detachAbort?.();
    const token = ++this.generation;
    const abort = () => { if (token === this.generation) void this.stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    this.detachAbort = () => options.signal?.removeEventListener("abort", abort);
    const copy = [...pattern];
    return this.enqueue(async () => {
      if (token !== this.generation) return;
      await this.driver.cancel();
      if (token === this.generation) await this.driver.play(copy);
    });
  }
  stop(): Promise<void> {
    ++this.generation;
    this.detachAbort?.();
    this.detachAbort = undefined;
    return this.enqueue(() => this.driver.cancel());
  }
}
export const haptics = new HapticService();

export async function bindHapticLifecycle(service = haptics): Promise<() => Promise<void>> {
  const onVisibility = () => service.setForeground("document", !document.hidden);
  document.addEventListener("visibilitychange", onVisibility);
  onVisibility();
  const handle = Capacitor.isNativePlatform()
    ? await App.addListener("appStateChange", ({ isActive }) => service.setForeground("native", isActive))
    : undefined;
  if (handle) service.setForeground("native", (await App.getState()).isActive);
  return async () => {
    document.removeEventListener("visibilitychange", onVisibility);
    await handle?.remove();
    service.configure(false);
    await service.stop();
    service.setForeground("document", true);
    service.setForeground("native", true);
  };
}
