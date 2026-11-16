import { haptics, type HapticsApi } from "./haptic-service";
import { hapticPreferences } from "./haptic-preferences";

interface TextOutputHapticsOptions {
  readonly enabled: () => boolean;
  readonly progressive?: () => boolean;
  readonly target?: HapticsApi;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly restored?: boolean;
}

/** One owner per output: redraws, skipped text and cancelled playback cannot replay completion. */
export class TextOutputHaptics {
  private readonly target: HapticsApi;
  private readonly now: () => number;
  private pulse = new AbortController();
  private visibleLength = 0;
  private lastPulse = -Infinity;
  private paused = false;
  private finished = false;
  constructor(private readonly options: TextOutputHapticsOptions) {
    this.target = options.target ?? haptics;
    this.now = options.now ?? (() => performance.now());
    options.signal?.addEventListener("abort", this.stop, { once: true });
    if (options.signal?.aborted) this.stop();
  }
  private allowed(): boolean { return !this.finished && !this.paused && !this.options.restored && !this.options.signal?.aborted && this.options.enabled(); }
  progress(text: string): void {
    const added = text.slice(this.visibleLength);
    this.visibleLength = text.length;
    if (!added.trim() || !this.allowed() || !(this.options.progressive?.() ?? hapticPreferences.get().output)) return;
    const now = this.now();
    // A short, sparse tick follows actual revealed text rather than animation frames.
    if (now - this.lastPulse < 90) return;
    this.lastPulse = now;
    void this.target.play([4], { signal: this.pulse.signal });
  }
  complete(text: string, manual = false): void {
    const notify = this.allowed() && Boolean(text.trim()) && !manual;
    this.finished = true;
    if (notify) void this.target.play([14], { signal: this.pulse.signal });
  }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.pulse.abort();
    else this.pulse = new AbortController();
  }
  stop = (): void => {
    this.finished = true;
    this.pulse.abort();
    this.options.signal?.removeEventListener("abort", this.stop);
  };
}
