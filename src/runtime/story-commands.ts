import { z } from "zod";
import type { StoryCommandExtension, StoryCommandIntent } from "../core/story/types";
import { advanceProgram, applyProgramEffects, chooseProgram, claimProgramReward, confirmProgramNode, createProgramRun, currentProgramNode, programChoiceOptions, programStartTrace, programTransitionTrace } from "../core/flow/program-engine";
import { ProgramEffectSchema, type ProgramRun } from "../core/flow/program";
import type { ProgramLifecycleChange } from "./program-events";
import { getCharacterMetadata } from "../content/characters/catalog";
import { getInstalledCharacterDefinition } from "../content/characters/loader";
import { invitationProgram } from "../content/encounters";
import { changeCharacterSkinUnlocks } from "../persistence/skin-unlocks";
import { validateLongTermSave, validateRuntimeSave } from "../persistence/schema";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import { projectProgramCheckpoint } from "./program-checkpoint";

const identifier = z.string().min(1).max(200);
const expected = { programId: identifier.optional(), nodeId: identifier.optional() };
const schemas = {
  "core.encounter.invite": z.object({ characterId: identifier, challengeId: identifier.optional(), weakenedSkills: z.array(identifier).max(64).optional() }).strict(),
  "core.program.choose": z.object({ ...expected, optionId: identifier }).strict(),
  "core.program.confirm": z.object(expected).strict(),
  "core.program.claim-reward": z.object({ ...expected, rewardId: identifier }).strict(),
  "core.program.effects": z.object({ ...expected, effects: z.array(ProgramEffectSchema).min(1).max(64) }).strict(),
  "core.skin.unlock": z.object({ characterId: identifier, skinId: identifier }).strict()
} as const;

export const STORY_COMMAND_CAPABILITIES: readonly StoryCommandExtension[] = Object.freeze(Object.entries(schemas)
  .map(([type, schema]) => Object.freeze({ type, apiVersion: 1, schema })));

/** All effects are pure projections of the owner's validated checkpoint, never async side effects. */
export function projectStoryCommand(intent: StoryCommandIntent, snapshot: RawSaveSnapshot,
  lifecycle?: (run: ProgramRun, changes: readonly ProgramLifecycleChange[]) => void): RawSaveSnapshot {
  const capability = STORY_COMMAND_CAPABILITIES.find(item => item.type === intent.type && item.apiVersion === intent.apiVersion);
  if (!capability) throw new Error(`剧情命令不受支持：${intent.type}@${intent.apiVersion}`);
  const save = validateLongTermSave(snapshot.longTerm);
  if (intent.type === "core.skin.unlock") {
    const { characterId, skinId } = schemas["core.skin.unlock"].parse(intent.args);
    const appearance = getCharacterMetadata(characterId)?.appearance;
    if (!appearance) throw new Error("角色服装不可用");
    return { ...snapshot, longTerm: changeCharacterSkinUnlocks(save, appearance, { [skinId]: true }) };
  }
  const facts = { defeated: save.defeats.map(item => item.opponentId), completedFlows: [...new Set([...(save.completedFlows ?? []), ...(save.completedChallenges ?? [])])] };
  if (intent.type === "core.encounter.invite") {
    const args = schemas["core.encounter.invite"].parse(intent.args);
    const previous = snapshot.runtime == null ? null : validateRuntimeSave(snapshot.runtime);
    if (previous?.activeProgram || previous?.activeFlow || previous?.activeChallenge || previous?.activeMatch)
      throw new Error("已有进行中的流程或牌局，不能接受新的剧情邀请");
    const character = getInstalledCharacterDefinition(args.characterId);
    if (!character) throw new Error("剧情邀请的角色包尚未安装或未启用");
    const { definition } = invitationProgram(character, save, args.weakenedSkills, args.challengeId);
    // The intent is already durable and bounded. Re-projecting an uncommitted retry creates the same run and table identity.
    const run = createProgramRun(intent.id, intent.id, definition, facts), next = advanceProgram(run, facts);
    if (currentProgramNode(next).type === "choice" && !programChoiceOptions(next, facts).length)
      throw new Error("所选流程没有可进入的节点");
    const initialTrace = programStartTrace(run);
    const changes: ProgramLifecycleChange[] = [{ type: "started" },
      ...(initialTrace.length ? initialTrace.map(item => ({ ...item })) : [{ type: "node-entered", nodeId: run.cursor, visitIndex: run.visitIndex, nodeType: currentProgramNode(run).type }]),
      ...(next === run ? [] : programTransitionTrace(next).map(item => ({ ...item })))];
    if (next.status === "finished") changes.push({ type: next.result === "abandoned" ? "abandoned" : "completed", result: next.result });
    lifecycle?.(next, changes);
    return { ...snapshot, ...projectProgramCheckpoint(save, next) };
  }
  const runtime = validateRuntimeSave(snapshot.runtime);
  const run = runtime.activeProgram;
  if (!run || run.status !== "waiting" || runtime.activeMatch) throw new Error("当前流程不能执行此剧情命令，请先完成牌局");
  const args = capability.schema.safeParse(intent.args);
  if (!args.success) throw new Error("剧情命令参数不符合契约");
  const identity = args.data as { programId?: string; nodeId?: string };
  if (identity.programId && identity.programId !== run.id || identity.nodeId && identity.nodeId !== run.cursor) throw new Error("剧情所属流程位置已改变");
  let next = run;
  switch (intent.type) {
    case "core.program.choose": next = chooseProgram(run, schemas["core.program.choose"].parse(intent.args).optionId, facts); break;
    case "core.program.confirm": next = confirmProgramNode(run, facts); break;
    case "core.program.claim-reward": next = claimProgramReward(run, schemas["core.program.claim-reward"].parse(intent.args).rewardId, facts); break;
    case "core.program.effects": {
      const effects = schemas["core.program.effects"].parse(intent.args).effects;
      if (new Set(effects.map(effect => effect.id)).size !== effects.length) throw new Error("剧情效果 ID 不得重复");
      next = applyProgramEffects(run, effects, `story:${intent.id}`, facts);
      break;
    }
  }
  if (next === run) return snapshot;
  const changes: ProgramLifecycleChange[] = programTransitionTrace(next).map(item => ({ ...item }));
  if (next.status === "finished") changes.push({ type: next.result === "abandoned" ? "abandoned" : "completed", result: next.result });
  if (changes.length) lifecycle?.(next, changes);
  const projected = projectProgramCheckpoint(save, next);
  return { ...snapshot, ...projected };
}
