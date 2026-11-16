import { afterEach, expect, it, vi } from "vitest";
import { DialoguePresenter } from "./dialogue-presenter";
import { createDefaultSave } from "../persistence/boot";
import { haptics } from "./haptic-service";

function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", { hidden: false, body: { classList: { contains: () => false } }, querySelector: () => null });
  const text = { textContent: "", dataset: {} as Record<string, string> };
  const portrait = { classList: { add: vi.fn(), remove: vi.fn() } };
  const root = { isConnected: true, querySelector: (selector: string) => selector === "#dialogue-text" ? text : selector === ".character-strip img" ? portrait : null };
  const presenter = new DialoguePresenter({ root: root as unknown as HTMLDivElement, save: createDefaultSave(), dialogueSession: undefined });
  const play = vi.spyOn(haptics, "play").mockResolvedValue();
  return { presenter, play, text };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps table output completion owned by the line across a partial redraw", async () => {
  const f = fixture(), line = "这是一句会逐字显示的对白";
  f.presenter.restore(line, "line-1", f.presenter.capture(line, "line-1"));
  await vi.advanceTimersByTimeAsync(72);
  expect(f.text.textContent.length).toBe(3);
  expect(f.play.mock.calls.some(call => call[0][0] === 4)).toBe(true);
  const snapshot = f.presenter.capture(line, "line-1");
  expect(snapshot.resumeTyping).toBe(true);
  f.presenter.restore(line, "line-1", snapshot);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.text.textContent).toBe(line);
  expect(f.play.mock.calls.filter(call => call[0][0] === 14)).toHaveLength(1);
  f.presenter.restore(line, "line-1", f.presenter.capture(line, "line-1"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.play.mock.calls.filter(call => call[0][0] === 14)).toHaveLength(1);
  f.presenter.dispose();
});

it("stops output feedback and typing when the table presenter is disposed", async () => {
  const f = fixture(), line = "切换页面后不继续输出";
  f.presenter.restore(line, "line-2", f.presenter.capture(line, "line-2"));
  await vi.advanceTimersByTimeAsync(48);
  f.presenter.dispose(); const calls = f.play.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.play).toHaveBeenCalledTimes(calls);
  expect(f.play.mock.calls.some(call => call[0][0] === 14)).toBe(false);
});
