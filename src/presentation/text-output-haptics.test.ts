import { describe, expect, it, vi } from "vitest";
import { TextOutputHaptics } from "./text-output-haptics";
import type { HapticOptions } from "./haptic-service";

function fixture(options: Partial<ConstructorParameters<typeof TextOutputHaptics>[0]> = {}) {
  let time = 0;
  const play = vi.fn(async (_pattern: readonly number[], _options?: HapticOptions) => {});
  const feedback = new TextOutputHaptics({ enabled: () => true, progressive: () => true, now: () => time, target: { play }, ...options });
  return { feedback, play, tick: (delta: number) => { time += delta; } };
}

describe("text output feedback", () => {
  it("follows revealed text with sparse ticks and emits completion just once", () => {
    const f = fixture();
    f.feedback.progress(""); f.feedback.progress("字");
    f.tick(30); f.feedback.progress("字符"); f.tick(60); f.feedback.progress("字符串");
    f.tick(100); f.feedback.progress("字符串"); f.feedback.progress("字符串 ");
    f.feedback.complete("字符串"); f.feedback.complete("字符串"); f.feedback.progress("字符串结束");
    expect(f.play.mock.calls.map(call => call[0])).toEqual([[4], [4], [14]]);
  });
  it("lets advanced feedback switch off independently of completion", () => {
    const f = fixture({ progressive: () => false });
    f.feedback.progress("文字"); f.feedback.complete("文字");
    expect(f.play.mock.calls.map(call => call[0])).toEqual([[14]]);
  });
  it("keeps restored, skipped, empty and disabled output silent", () => {
    for (const options of [{ restored: true }, { enabled: () => false }]) {
      const f = fixture(options); f.feedback.progress("文字"); f.feedback.complete("文字"); expect(f.play).not.toHaveBeenCalled();
    }
    const manual = fixture(); manual.feedback.complete("全文", true); manual.feedback.complete("全文"); expect(manual.play).not.toHaveBeenCalled();
    const empty = fixture(); empty.feedback.progress(" "); empty.feedback.complete(" "); expect(empty.play).not.toHaveBeenCalled();
  });
  it("cancels paused and disposed owners and resumes only on new output", () => {
    const controller = new AbortController(), f = fixture({ signal: controller.signal });
    f.feedback.progress("一");
    const firstSignal = f.play.mock.calls[0][1]!.signal!;
    f.feedback.setPaused(true); expect(firstSignal.aborted).toBe(true);
    f.tick(200); f.feedback.progress("一二"); expect(f.play).toHaveBeenCalledOnce();
    f.feedback.setPaused(false); f.feedback.progress("一二三"); expect(f.play).toHaveBeenCalledTimes(2);
    const resumedSignal = f.play.mock.calls[1][1]!.signal!; expect(resumedSignal.aborted).toBe(false);
    controller.abort(); expect(resumedSignal.aborted).toBe(true);
    f.feedback.complete("一二三"); expect(f.play).toHaveBeenCalledTimes(2);
  });
});
