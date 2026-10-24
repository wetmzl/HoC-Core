import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatch, gameReducer } from "../core/match/reducer";
import { AiController } from "./ai-controller";

function harness() {
  let state = gameReducer(createMatch("ai-scheduling"), { type: "PLAYER_STAND" });
  let paused = false;
  const dispatch = vi.fn();
  const showThinking = vi.fn();
  const controller = new AiController({ getState: () => state, isPaused: () => paused, dispatch, showThinking });
  return { controller, dispatch, showThinking, state: () => state,
    pause: (value: boolean) => { paused = value; }, replace: () => { state = createMatch("replacement"); } };
}
afterEach(() => vi.useRealTimers());
describe("AI presentation scheduling", () => {
  it("deduplicates redraws and dispatches once", () => {
    vi.useFakeTimers();
    const h = harness();
    h.controller.scheduleAiTurn(h.state());
    h.controller.scheduleAiTurn(h.state());
    vi.runAllTimers();
    expect(h.showThinking).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "AI_TURN" });
  });
  it("pauses with debug controls and resumes from the same state", () => {
    vi.useFakeTimers();
    const h = harness();
    h.controller.scheduleAiTurn(h.state());
    h.pause(true);
    h.controller.scheduleAiTurn(h.state());
    vi.runAllTimers();
    expect(h.dispatch).not.toHaveBeenCalled();
    h.pause(false);
    h.controller.scheduleAiTurn(h.state());
    vi.runAllTimers();
    expect(h.dispatch).toHaveBeenCalledOnce();
  });
  it("cancels delayed work on dispose and ignores later scheduling", () => {
    vi.useFakeTimers();
    const h = harness();
    h.controller.scheduleAiTurn(h.state());
    h.controller.dispose();
    h.controller.dispose();
    h.controller.scheduleAiTurn(h.state());
    vi.runAllTimers();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.showThinking).not.toHaveBeenCalled();
  });
  it("rechecks the current session before showing a pose or acting", () => {
    vi.useFakeTimers();
    const h = harness();
    h.controller.scheduleAiTurn(h.state());
    h.replace();
    vi.runAllTimers();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.showThinking).not.toHaveBeenCalled();
  });
});
