import { describe, expect, it, vi } from "vitest";
import { createMatch } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { createMatchTransition } from "../runtime/match-transition";
import { createMatchFactBatch } from "../core/events";
import { presentInteractionHaptic, presentMatchHapticsFacts, presentMatchHapticsTransition } from "./haptics";

describe("match haptics", () => {
  it("uses a minimal pulse for successful button interactions", () => {
    const play = vi.fn(async () => undefined);
    presentInteractionHaptic(true, { play });
    expect(play).toHaveBeenCalledWith([8]);
  });

  it("keeps interaction feedback silent when reduced effects disable haptics", () => {
    const play = vi.fn(async () => undefined);
    presentInteractionHaptic(false, { play });
    expect(play).not.toHaveBeenCalled();
  });

  it("uses distinct confirmation, dry-fire, and gunshot patterns", () => {
    const base = createMatch("haptics");
    const play = vi.fn(async () => undefined);
    const confirmed: MatchState = { ...base, history: [...base.history, { type: "ROUND_RESULT_ACKNOWLEDGED" }] };
    presentMatchHapticsTransition(createMatchTransition(base, confirmed), true, { play });

    const dry: MatchState = { ...confirmed, history: [...confirmed.history, { type: "TRIGGER_PULLED", actor: "player", probability: 0.5, baseProbability: 0.5, misfireChance: 0, result: "empty-chamber", fired: false }] };
    presentMatchHapticsTransition(createMatchTransition(confirmed, dry), true, { play });

    const fired: MatchState = { ...dry, history: [...dry.history, { type: "TRIGGER_PULLED", actor: "opponent", probability: 1, baseProbability: 1, misfireChance: 0, result: "fired", fired: true }] };
    presentMatchHapticsTransition(createMatchTransition(dry, fired), true, { play });
    expect(play.mock.calls).toEqual([[[18]], [[22, 35, 28]], [[70, 30, 120]]]);
  });

  it("stays silent when reduced effects disable haptics", () => {
    const state = createMatch("haptics-off");
    const play = vi.fn(async () => undefined);
    const after: MatchState = { ...state, history: [...state.history, { type: "ROUND_RESULT_ACKNOWLEDGED" }] };
    presentMatchHapticsTransition(createMatchTransition(state, after), false, { play });
    expect(play).not.toHaveBeenCalled();
  });

  it("uses committed fact payloads and never vibrates for restored history", () => {
    const before = createMatch("haptic-facts");
    const trigger = { type: "TRIGGER_PULLED" as const, actor: "player" as const, probability: 1, baseProbability: 1, misfireChance: 0, result: "fired" as const, fired: true };
    const after: MatchState = { ...before, history: [...before.history, trigger] };
    const batch = createMatchFactBatch(before, after);
    trigger.fired = false;
    const play = vi.fn(async () => undefined);
    presentMatchHapticsFacts(batch, true, { play });
    presentMatchHapticsFacts(createMatchFactBatch(undefined, after, { restored: true }), true, { play });
    expect(play.mock.calls).toEqual([[[70, 30, 120]]]);
  });
});
