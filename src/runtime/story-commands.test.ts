import { describe, expect, it, vi } from "vitest";
import { createDefaultSave } from "../persistence/boot";
import { loadCharacter } from "../content/characters";
import { getInstalledCharacterDefinition } from "../content/characters/loader";
import { invitationProgram } from "../content/encounters";
import { createProgramRun } from "../core/flow/program-engine";
import { ProgramDefinitionSchema } from "../core/flow/program";
import { projectProgramCheckpoint } from "./program-checkpoint";
import { projectStoryCommand } from "./story-commands";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import { validateRuntimeSave } from "../persistence/schema";

function checkpoint(): RawSaveSnapshot {
  const definition = ProgramDefinitionSchema.parse({ version: 2, id: "neutral-story-flow", start: "welcome", nodes: [
    { id: "welcome", type: "presentation", body: "欢迎", next: "end" },
    { id: "end", type: "end", result: "victory", effects: [{ id: "finish", type: "complete-flow" }] }
  ] });
  return projectProgramCheckpoint(createDefaultSave(), createProgramRun("flow-test", "seed", definition));
}

describe("story host commands", () => {
  it("projects a normal legal invitation with a stable run identity and initial lifecycle", async () => {
    const save = createDefaultSave(), character = await loadCharacter("llama");
    const intent = { id: "accepted-story:1:invite", type: "core.encounter.invite", apiVersion: 1, args: { characterId: character.id } };
    const source = { longTerm: save, runtime: null }, before = structuredClone(source), lifecycle = vi.fn();
    const projected = projectStoryCommand(intent, source, lifecycle), runtime = validateRuntimeSave(projected.runtime);
    expect(runtime.activeProgram?.id).toBe(intent.id);
    expect(runtime.activeProgram?.definition).toEqual(invitationProgram(character, save).definition);
    expect(runtime.activeProgram?.status).toBe("match");
    expect(runtime.activeMatch).toBeNull();
    expect(validateRuntimeSave(projectStoryCommand(intent, source).runtime).activeProgram).toEqual(runtime.activeProgram);
    expect(lifecycle).toHaveBeenCalledWith(runtime.activeProgram, [expect.objectContaining({ type: "started" }),
      expect.objectContaining({ type: "node-entered", nodeType: "initialize" }),
      expect.objectContaining({ type: "node-left", nodeType: "initialize" }),
      expect.objectContaining({ type: "node-entered", nodeType: "match" })]);
    expect(source).toEqual(before);
    expect(getInstalledCharacterDefinition(character.id)).toBe(character);
  });
  it("refuses to replace any active flow or table and leaves the checkpoint untouched", () => {
    const source = checkpoint(), before = structuredClone(source);
    expect(() => projectStoryCommand({ id: "invite", type: "core.encounter.invite", apiVersion: 1,
      args: { characterId: "llama" } }, source)).toThrow("已有进行中的流程或牌局");
    expect(source).toEqual(before);
  });
  it("keeps installed content, unlock, challenge and parameter validation on the ordinary invitation path", () => {
    const source = { longTerm: createDefaultSave(), runtime: null };
    const invite = (args: Record<string, unknown>) => projectStoryCommand({ id: "invite", type: "core.encounter.invite", apiVersion: 1, args }, source);
    expect(() => invite({ characterId: "missing-guest" })).toThrow("尚未安装或未启用");
    expect(() => invite({ characterId: "llama", challengeId: "unowned-challenge" })).toThrow("不属于此角色");
    expect(() => invite({ characterId: "claude" })).toThrow("尚未解锁");
    expect(() => invite({ characterId: "llama", ignored: true })).toThrow();
    expect(() => invite({ characterId: "llama", weakenedSkills: [""] })).toThrow();
  });
  it("applies a declared resource reward through the flow engine with an idempotent receipt", () => {
    const intent = { id: "story:run:reward", type: "core.program.effects", apiVersion: 1,
      args: { effects: [{ id: "bonus", type: "resource", resource: "comparisonBonus", operation: "add", value: 3 }] } };
    const first = projectStoryCommand(intent, checkpoint());
    expect((first.runtime as { activeProgram: { resources: { comparisonBonus: number } } }).activeProgram.resources.comparisonBonus).toBe(3);
    expect(projectStoryCommand(intent, first)).toEqual(first);
  });
  it("materializes flow completion through the ordinary durable progress rules", () => {
    const result = projectStoryCommand({ id: "finish", type: "core.program.confirm", apiVersion: 1, args: { nodeId: "welcome" } }, checkpoint());
    expect(result.runtime).toBeNull();
    expect((result.longTerm as { completedFlows: string[] }).completedFlows).toContain("neutral-story-flow");
  });
  it("refuses obsolete flow positions and unknown commands without altering either record", () => {
    const source = checkpoint(), before = structuredClone(source);
    expect(() => projectStoryCommand({ id: "stale", type: "core.program.confirm", apiVersion: 1, args: { nodeId: "elsewhere" } }, source)).toThrow("位置已改变");
    expect(() => projectStoryCommand({ id: "unknown", type: "unknown.write", apiVersion: 1, args: {} }, source)).toThrow("不受支持");
    expect(source).toEqual(before);
  });
});
