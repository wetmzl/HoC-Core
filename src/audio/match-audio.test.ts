import { describe, expect, it } from "vitest";
import { createMatch } from "../core/match/reducer";
import type { GameEvent, MatchState, RoundOutcome, RoundPhase } from "../core/match/types";
import type { SoundCue } from "./game-audio";
import { presentMatchAudio, syncMatchAudioState, type MatchAudioPort } from "./match-audio";

class RecordingAudio implements MatchAudioPort {
  readonly calls: string[] = [];
  play(cue: Exclude<SoundCue, "heartbeat">, delayMs = 0): void { this.calls.push(`play:${cue}:${delayMs}`); }
  startHeartbeat(): void { this.calls.push("heartbeat:start"); }
  stopHeartbeat(): void { this.calls.push("heartbeat:stop"); }
}

function withEvents(state: MatchState, phase: RoundPhase, ...events: GameEvent[]): MatchState {
  return { ...state, round: { ...state.round, phase }, history: [...state.history, ...events] };
}

const COMPARISON: RoundOutcome = {
  winner: "player",
  reason: "comparison",
  penaltyTarget: "opponent",
  bulletsAdded: 1
};

describe("match audio presentation mapping", () => {
  it("maps new rounds, hits, busts, and Blackjacks without delaying the card flip", () => {
    const before = createMatch("audio-table");
    const after = withEvents(before, "round-reveal",
      { type: "ROUND_STARTED", roundIndex: 1 },
      { type: "PLAYER_HIT", value: 24 },
      { type: "BUST", actor: "player" },
      { type: "BLACKJACK", actor: "opponent" }
    );
    const audio = new RecordingAudio();
    presentMatchAudio(audio, before, after);
    expect(audio.calls).toEqual([
      "play:shuffle:0",
      "play:cardFlip:0",
      "play:blackjack:160",
      "play:bust:160"
    ]);
  });

  it("plays a chosen Stand before comparison, then confirms before heartbeat", () => {
    const before = createMatch("audio-compare");
    const afterBase = withEvents(before, "round-reveal",
      { type: "PLAYER_STOOD" },
      { type: "ROUND_RESOLVED", outcome: COMPARISON }
    );
    const after = { ...afterBase, round: { ...afterBase.round, outcome: COMPARISON } };
    const audio = new RecordingAudio();
    presentMatchAudio(audio, before, after);
    expect(audio.calls).toEqual(["play:stand:0", "play:compare:160"]);

    const confirmed = withEvents(after, "roulette-trigger", { type: "ROUND_RESULT_ACKNOWLEDGED" });
    presentMatchAudio(audio, after, confirmed);
    expect(audio.calls).toEqual(["play:stand:0", "play:compare:160", "play:stand:0", "heartbeat:start"]);
  });

  it("routes drawing and using a player skill through replaceable cues", () => {
    const before = createMatch("audio-skills");
    const after = withEvents(before, "turns",
      { type: "SKILL_DRAW_OPENED", offerId: "offer-1", candidateDefinitionIds: ["critical-judgment"] },
      { type: "ABILITY_PLAYED", instanceId: "skill-1", definitionId: "critical-judgment", owner: "player" }
    );
    const audio = new RecordingAudio();
    presentMatchAudio(audio, before, after);
    expect(audio.calls).toEqual(["play:skillDraw:0", "play:skillUse:0"]);
  });

  it("does not play the player skill cue for an opponent ability", () => {
    const before = createMatch("audio-opponent-skill");
    const after = withEvents(before, "turns",
      { type: "ABILITY_PLAYED", instanceId: "skill-1", definitionId: "opponent-skill", owner: "opponent" }
    );
    const audio = new RecordingAudio();
    presentMatchAudio(audio, before, after);
    expect(audio.calls).toEqual([]);
  });

  it("starts player suspense only after accepting the penalty, then stops it for a dry chamber", () => {
    const base = createMatch("audio-trigger");
    const playerPenalty: RoundOutcome = { ...COMPARISON, winner: "opponent", penaltyTarget: "player"};
    const reveal = { ...base, round: { ...base.round, phase: "round-reveal" as const, outcome: playerPenalty } };
    const audio = new RecordingAudio();
    syncMatchAudioState(audio, reveal);
    expect(audio.calls).toEqual(["heartbeat:stop"]);

    const waiting = { ...reveal, round: { ...reveal.round, phase: "roulette-reaction" as const } };
    presentMatchAudio(audio, reveal, waiting);
    expect(audio.calls).toEqual(["heartbeat:stop", "heartbeat:start"]);

    const result = withEvents(waiting, "roulette-result", { type: "TRIGGER_PULLED", actor: "player", probability: 1 / 6, baseProbability: 1 / 6, misfireChance: 0, result: "empty-chamber", fired: false });
    presentMatchAudio(audio, waiting, result);
    expect(audio.calls).toEqual(["heartbeat:stop", "heartbeat:start", "heartbeat:stop", "play:dryFire:0"]);
  });

  it("confirms a push with Stand, then shuffles without starting heartbeat", () => {
    const push: RoundOutcome = { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0};
    const revealBase = createMatch("audio-push");
    const reveal = { ...revealBase, round: { ...revealBase.round, phase: "round-reveal" as const, outcome: push } };
    const next = withEvents(reveal, "turns",
      { type: "ROUND_RESULT_ACKNOWLEDGED" },
      { type: "ROUND_STARTED", roundIndex: reveal.roundIndex + 1 }
    );
    const audio = new RecordingAudio();
    presentMatchAudio(audio, reveal, next);
    expect(audio.calls).toEqual(["play:stand:0", "play:shuffle:220"]);
  });

  it("plays gunshot immediately and result only when the final summary opens", () => {
    const waiting = withEvents(createMatch("audio-gunshot"), "roulette-trigger");
    const fired = withEvents(waiting, "roulette-result", { type: "TRIGGER_PULLED", actor: "opponent", probability: 1, baseProbability: 1, misfireChance: 0, result: "fired", fired: true });
    const audio = new RecordingAudio();
    presentMatchAudio(audio, waiting, fired);
    expect(audio.calls).toEqual(["heartbeat:stop", "play:gunshot:0"]);

    const summary = { ...fired, status: "finished" as const, view: "match-summary" as const };
    presentMatchAudio(audio, fired, summary);
    expect(audio.calls).toEqual(["heartbeat:stop", "play:gunshot:0", "play:result:0"]);
  });

  it("routes an ability-caused misfire to its own replaceable cue", () => {
    const waiting = withEvents(createMatch("audio-misfire"), "roulette-trigger");
    const misfired = withEvents(waiting, "roulette-result", {
      type: "TRIGGER_PULLED", actor: "player", probability: 1 / 3, baseProbability: 2 / 3,
      misfireChance: 1 / 3, result: "misfire", fired: false
    });
    const audio = new RecordingAudio();
    presentMatchAudio(audio, waiting, misfired);
    expect(audio.calls).toEqual(["heartbeat:stop", "play:misfire:0"]);
  });
});
