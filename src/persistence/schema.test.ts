import { describe, expect, it } from "vitest";
import { createCard } from "../core/blackjack/card";
import { createMatch, gameReducer, getLegalActions } from "../core/match/reducer";
import type { MatchState, ParticipantState } from "../core/match/types";
import { createRuntimeSave } from "./boot";
import { assertMatchStateForSave, MatchStateSchema, validateRuntimeSave } from "./schema";

function match(): MatchState {
  return createMatch("save-participant-consistency", { opponentId: "chatgpt" });
}

describe("runtime save duplicate state consistency", () => {
  it("rejects mismatched round indices on both save and load", () => {
    const state = match();
    const invalid = { ...state, round: { ...state.round, index: state.roundIndex + 99 } };
    expect(() => assertMatchStateForSave(invalid)).toThrow("round.index");
    expect(() => validateRuntimeSave({ ...createRuntimeSave(state), activeMatch: invalid })).toThrow("round index disagrees");
  });

  const changes: readonly [string, (participant: ParticipantState) => ParticipantState][] = [
    ["identity", participant => ({ ...participant, id: participant.id === "player" ? "opponent" : "player" })],
    ["hand", participant => ({ ...participant, hand: { cards: [] } })],
    ["card identity", participant => ({ ...participant, hand: { cards: participant.hand.cards.map((card, index) => index ? card : { ...card, id: "changed-card" }) } })],
    ["card attributes", participant => ({ ...participant, hand: { cards: participant.hand.cards.map((card, index) => index ? card : createCard(card.attributes.suit, card.attributes.rank === "A" ? "2" : "A", card.id)) } })],
    ["card tags", participant => ({ ...participant, hand: { cards: participant.hand.cards.map((card, index) => index ? card : { ...card, tags: [...card.tags, "changed-tag"] }) } })],
    ["stood", participant => ({ ...participant, stood: !participant.stood })],
    ["busted", participant => ({ ...participant, busted: !participant.busted })],
    ["bust limit", participant => ({ ...participant, bustLimit: (participant.bustLimit ?? 21) + 1 })]
  ];
  for (const actor of ["player", "opponent"] as const) {
    it.each(changes)(`rejects contradictory ${actor} %s without rewriting the input`, (_name, change) => {
      const state = match();
      const invalid = { ...state, round: { ...state.round, [actor]: change(state[actor]) } };
      const before = structuredClone(invalid);
      const result = MatchStateSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["round", actor], message: "round participant disagrees with match participant" }));
      expect(invalid).toEqual(before);
    });
  }

  it("roundtrips normal transitions with separate JSON copies of both participant fields", () => {
    let state = match();
    for (let step = 0; step < 12; step++) {
      const snapshot = createRuntimeSave(state, "2026-10-22T00:00:00.000Z");
      const parsed = validateRuntimeSave(JSON.parse(JSON.stringify(snapshot)));
      expect(parsed).toEqual(snapshot);
      expect(parsed.activeMatch.player).not.toBe(parsed.activeMatch.round.player);
      const action = getLegalActions(state).find(action => action.type !== "PLAY_ABILITY" && action.type !== "OPEN_SKILL_DRAW" && action.type !== "ESCAPE_MATCH");
      if (!action) break;
      state = gameReducer(parsed.activeMatch, action);
    }
  });

  it("preserves optional legacy fields and treats card tags as sets", () => {
    const state = match();
    const { autoSkipAfterStand: _autoSkipAfterStand, ...legacy } = state;
    const player = { ...state.player, hand: { cards: state.player.hand.cards.map(card => ({ ...card, tags: ["first", "second"] })) } };
    const roundPlayer = { ...player, hand: { cards: player.hand.cards.map(card => ({ ...card, tags: ["second", "first"] })) } };
    const compatible = { ...legacy, player, round: { ...state.round, player: roundPlayer } };
    expect(MatchStateSchema.parse(compatible)).toEqual(compatible);
    expect(validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(compatible)))).activeMatch).toEqual(compatible);
  });
});
