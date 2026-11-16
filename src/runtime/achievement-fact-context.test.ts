import { describe, expect, it } from "vitest";
import { createMatch } from "../core/match/reducer";
import { createProgramRun, programMatchId } from "../core/flow/program-engine";
import { ProgramDefinitionSchema } from "../core/flow/program";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import type { MatchFactBatch } from "../core/events";
import type { AutosaveController } from "../persistence/autosave";
import { EncounterSession } from "./encounter-session";
import { ProgramSession } from "./program-session";

describe.each(["program", "legacy"] as const)("%s live achievement facts", mode => {
  it("preserves original match batches before save validation detaches event sidecars", async () => {
    let save = createDefaultSave();
    const repository = new MemorySaveRepository({ longTerm: save });
    const saves = { get: () => save, set: (next: typeof save) => { save = next; } };
    const contexts: (readonly MatchFactBatch[])[] = [];
    repository.addCheckpointProjector((_previous, proposed, context) => {
      if (context.matchFacts) contexts.push(context.matchFacts);
      return proposed;
    });
    let handle: AutosaveController;
    const session = mode === "program" ? new ProgramSession(repository, saves) : new EncounterSession(repository, saves);
    if (session instanceof ProgramSession) {
      const definition = ProgramDefinitionSchema.parse({ version: 2, id: "fact-context", start: "match", nodes: [
        { id: "match", type: "match", opponentId: "llama", routes: { victory: "end", defeat: "end", escaped: "end" } },
        { id: "end", type: "end", result: "victory" }
      ] });
      await session.begin(createProgramRun("fact-context-run", "seed", definition));
      handle = await session.attach(session.run!, createMatch("seed", { id: programMatchId(session.run!), opponentId: "llama", openingSkillCards: 0 }));
    } else handle = await session.attach(undefined, createMatch("legacy-fact-context", { opponentId: "llama", openingSkillCards: 0 }));
    expect(contexts).toHaveLength(1);
    expect(contexts[0][0].after).toBe(handle.getState());
    expect(contexts[0][0].fromIndex).toBe(0);
    const before = handle.getState(), after = handle.dispatch({ type: "PLAYER_STAND" });
    await handle.flush();
    expect(contexts).toHaveLength(2);
    const live = contexts[1][0];
    expect(live.before).toBe(before); expect(live.after).toBe(after);
    expect(live.events[0]).toBe(after.history[before.history.length]);
    expect(live.fromIndex).toBe(before.history.length);
    expect(live.toIndex).toBe(after.history.length);
    expect((await repository.loadRuntime())?.activeMatch).not.toBe(after);
    let unavailable = true;
    const releaseFailure = repository.addCheckpointProjector((_previous, proposed) => {
      if (unavailable) throw new Error("checkpoint unavailable");
      return proposed;
    });
    const settled = handle.dispatch({ type: "OPPONENT_STAND" }), settledBatch = handle.getLastFactBatch!()!;
    await expect(handle.flush()).rejects.toThrow("checkpoint unavailable");
    expect((await repository.loadRuntime())?.activeMatch?.history).toEqual(after.history);
    unavailable = false;
    const continued = handle.dispatch({ type: "ACK_ROUND_RESULT" }), continuedBatch = handle.getLastFactBatch!()!;
    expect(continued).not.toBe(settled);
    await handle.flush();
    const retried = contexts.at(-1)!;
    expect(retried).toHaveLength(2);
    expect(retried[0]).toBe(settledBatch); expect(retried[1]).toBe(continuedBatch);
    expect(retried[0].after).toBe(settled); expect(retried[1].after).toBe(continued);
    releaseFailure();
    await session.abandon();
    expect(contexts.at(-1)).toHaveLength(1);
    expect(contexts.at(-1)![0].after).toBe(continued);
    await session.dispose();
  });
});
