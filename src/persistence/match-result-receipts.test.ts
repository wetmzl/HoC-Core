import { expect, it } from "vitest";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { acknowledgeMatchResult, clearMatchHistory, createDefaultSave, recordMatchProgress } from "./boot";
import { exportSaveJson, importSave } from "./json";
import { recoverLongTermSave } from "./recover-save";
import { validateLongTermSave } from "./schema";

function result(id: string, outcome: "victory" | "defeat" | "escaped" = "victory"): MatchState {
  const match = createMatch(id, { id, opponentId: "llama", opponentAiSkills: [] });
  if (outcome === "escaped") return gameReducer(gameReducer(match, { type: "ESCAPE_MATCH" }), { type: "ACK_MATCH_RESULT" });
  const target = outcome === "victory" ? "opponent" : "player";
  const winner = outcome === "victory" ? "player" : "opponent";
  const pending: MatchState = { ...match, roulette: { ...match.roulette, [target]: { ...match.roulette[target], bullets: match.roulette[target].capacity } },
    round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner, reason: "comparison", penaltyTarget: target, bulletsAdded: 1 } } };
  return gameReducer(gameReducer(gameReducer(pending, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" }), { type: "ACK_MATCH_RESULT" });
}

it("keeps immediate victory progress independent of a deferred result and preserves both receipts across import", async () => {
  const win = result("deferred");
  let save = recordMatchProgress(createDefaultSave(), win);
  expect(save.characterDefeatProgress).toEqual({ counts: { llama: 1 }, matchIds: [win.id] });
  expect(save.matchResultReceipts).toEqual([]);
  expect(save.history).toEqual([]);
  expect(recordMatchProgress(save, win)).toBe(save);
  save = acknowledgeMatchResult(await importSave(exportSaveJson(save)), win);
  expect(save.history.map(record => record.id)).toEqual([win.id]);
  expect(save.profile).toMatchObject({ matchesPlayed: 1, wins: 1 });
  expect(save.characterDefeatProgress?.counts.llama).toBe(1);
  save = await importSave(exportSaveJson(clearMatchHistory(save)));
  expect(recordMatchProgress(save, win)).toBe(save);
  expect(acknowledgeMatchResult(save, win)).toBe(save);
});

it.each(["defeat", "escaped"] as const)("keeps %s result receipts after clearing history without creating victory progress", async outcome => {
  const match = result(outcome, outcome), initial = createDefaultSave();
  expect(recordMatchProgress(initial, match)).toBe(initial);
  let save = acknowledgeMatchResult(initial, match);
  expect(save.profile).toMatchObject({ matchesPlayed: 1, wins: 0 });
  expect(save.characterDefeatProgress).toBeUndefined();
  save = await importSave(exportSaveJson(clearMatchHistory(save)));
  expect(save.matchResultReceipts).toEqual([match.id]);
  expect(acknowledgeMatchResult(save, match)).toBe(save);
});

it("preserves the old cleared-victory deduplication while accepting a new deferred result", () => {
  const old = result("old"), next = result("next");
  const saved = clearMatchHistory(acknowledgeMatchResult(createDefaultSave(), old));
  const { matchResultReceipts: _receipts, ...legacy } = saved;
  expect(acknowledgeMatchResult(legacy, old)).toBe(legacy);
  let save = recordMatchProgress(legacy, next);
  expect(save.matchResultReceipts).toEqual([old.id]);
  save = acknowledgeMatchResult(save, next);
  expect(save.history.map(record => record.id)).toEqual([next.id]);
  expect(save.characterDefeatProgress?.counts.llama).toBe(2);
  expect(save.profile).toMatchObject({ matchesPlayed: 2, wins: 2 });
  expect(acknowledgeMatchResult(clearMatchHistory(save), old).profile.matchesPlayed).toBe(2);
});

it("migrates old loss history before deletion and recovers independent receipt damage", () => {
  const loss = result("old-loss", "defeat");
  const { matchResultReceipts: _receipts, ...legacy } = acknowledgeMatchResult(createDefaultSave(), loss);
  const cleared = clearMatchHistory(legacy);
  expect(acknowledgeMatchResult(cleared, loss)).toBe(cleared);
  const raw = { ...cleared, matchResultReceipts: [loss.id, loss.id, 2, "", "valid"] };
  expect(() => validateLongTermSave(raw)).toThrow();
  const recovered = recoverLongTermSave(raw);
  expect(recovered.matchResultReceipts).toEqual([loss.id, "valid"]);
  expect(recovered.recovery?.originals).toEqual([raw]);
});
