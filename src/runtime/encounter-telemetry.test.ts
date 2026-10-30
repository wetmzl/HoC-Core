import { describe, expect, it, vi } from "vitest";
import trial from "../core/challenge/fixtures/legacy-challenge.json";
import { createChallenge } from "../core/challenge/reducer";
import { ChallengeDefinitionSchema } from "../core/challenge/schema";
import { CHARACTER_CATALOG } from "../content/characters";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { EncounterSession } from "./encounter-session";
import { challengeFlowRun, flowSnapshot, singleMatchFlow } from "./encounter-snapshot";

describe("organizer-owned telemetry", () => {
  it("reports non-recorded guard nodes and makes no fictitious report on a failed withdrawal", async () => {
    let save = createDefaultSave(); const repository = new MemorySaveRepository({ longTerm: save });
    const observe = vi.fn(async (_match: import("../core/match/types").MatchState, _run: import("../core/flow/schema").FlowRun) => undefined);
    const session = new EncounterSession(repository, { get: () => save, set: next => { save = next; } }, { observe });
    const definition = ChallengeDefinitionSchema.parse(trial);
    const run = challengeFlowRun(createChallenge("telemetry-run", definition,
      definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-26T00:00:00Z" })), CHARACTER_CATALOG));
    await session.begin(run); const prepared = session.prepare("guard:llama")!;
    const match = createMatch(prepared.plan.seed, { ...prepared.plan.options, opponentId: prepared.plan.opponentId });
    await session.attach(prepared.run, match); observe.mockClear();
    const write = repository.saveRuntime.bind(repository); let fail = true;
    repository.saveRuntime = async snapshot => { if (fail) { fail = false; throw new Error("write failed"); } await write(snapshot); };
    await expect(session.settle(true)).rejects.toThrow("write failed"); expect(observe).not.toHaveBeenCalled();
    await session.settle(true);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0]).toMatchObject({ status: "finished", outcome: { reason: "escaped" } });
    expect(save.history).toHaveLength(0); expect(repository.commits).toHaveLength(0);
  });
  it("telemetry failure cannot prevent settlement or alter durable game results", async () => {
    let save = createDefaultSave(); const repository = new MemorySaveRepository({ longTerm: save });
    const session = new EncounterSession(repository, { get: () => save, set: next => { save = next; } }, { observe: async () => { throw new Error("telemetry disk unavailable"); } });
    const match = gameReducer(createMatch("ordinary-telemetry", { opponentId: "chatgpt", opponentAiSkills: [] }), { type: "ESCAPE_MATCH" });
    await session.replace(flowSnapshot(singleMatchFlow(match), match));
    await expect(session.settle()).resolves.toBeUndefined();
    expect(save.history).toHaveLength(1); expect(await repository.loadRuntime()).toBeNull();
  });
});
