import { createPublicQueryContext, readPublicQuery } from "../events/public-queries";
import { evaluatePublicCondition } from "../events/triggers";
import { STORY_LIMITS } from "./schema";
import { storyComposition } from "./composition";
import type { StoryAction, StoryActorState, StoryCommandReceipt, StoryCondition, StoryEngineContext, StoryRun, StoryScene, StoryStage, StoryValue, StoryScalar } from "./types";

export function readStoryValue(value: StoryValue, run: StoryRun, context: StoryEngineContext): StoryScalar | undefined {
  return value.type === "literal" ? value.value : value.type === "variable" ? Object.hasOwn(run.variables, value.key) ? run.variables[value.key] : undefined
    : context.publicContext ? readPublicQuery(value.query, createPublicQueryContext(context.publicContext)) : undefined;
}
function evaluateCondition(condition: StoryCondition, run: StoryRun, context: StoryEngineContext): boolean | undefined {
  if (condition.type === "all" || condition.type === "any") {
    const children = condition.conditions.map(child => evaluateCondition(child, run, context));
    return condition.type === "all" ? children.includes(false) ? false : children.includes(undefined) ? undefined : true
      : children.includes(true) ? true : children.includes(undefined) ? undefined : false;
  }
  if (condition.type === "not") { const value = evaluateCondition(condition.condition, run, context); return value === undefined ? undefined : !value; }
  if (condition.type === "public") return context.publicContext ? evaluatePublicCondition(condition.condition, context.publicContext) : undefined;
  if (condition.type !== "compare") return undefined;
  const left = readStoryValue(condition.left, run, context), right = readStoryValue(condition.right, run, context);
  if (left === undefined || right === undefined) return undefined;
  if (condition.operator === "eq") return left === right;
  if (condition.operator === "neq") return left !== right;
  if (typeof left !== "number" || typeof right !== "number") return false;
  return condition.operator === "lt" ? left < right : condition.operator === "lte" ? left <= right : condition.operator === "gt" ? left > right : left >= right;
}
export function evaluateStoryCondition(condition: StoryCondition, run: StoryRun, context: StoryEngineContext): boolean { return evaluateCondition(condition, run, context) === true; }
export function interpolateStoryText(text: string, variables: Readonly<Record<string, StoryScalar>>): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9._-]*)\s*\}\}/g, (original, key: string) => Object.hasOwn(variables, key) ? String(variables[key] ?? "") : original);
}
function actorDefault(id: string, scene?: StoryScene): StoryActorState {
  const definition = scene?.actors && Object.hasOwn(scene.actors, id) ? scene.actors[id] : undefined;
  return { id, image: definition?.image, x: 50, y: 100, scale: definition?.scale ?? 1, rotation: 0, opacity: 1, visible: true, anchorX: 0.5, anchorY: 1, layer: 0 };
}
/** Terminal visual state is independent of the browser's animation clock. */
export function applyStoryAction(stage: StoryStage, action: StoryAction, scene?: StoryScene): StoryStage {
  if (action.type === "sequence" || action.type === "parallel") return action.actions.reduce((state, child) => applyStoryAction(state, child, scene), stage);
  if (action.type === "stage") {
    const actors = { ...stage.actors };
    for (const actor of action.remove ?? []) delete actors[actor];
    for (const changes of action.actors ?? []) actors[changes.id] = { ...(Object.hasOwn(actors, changes.id) ? actors[changes.id] : actorDefault(changes.id, scene)), ...changes };
    return { ...stage, ...(action.background !== undefined ? { background: action.background } : {}), ...(action.overlay !== undefined ? { overlay: action.overlay } : {}), actors };
  }
  if (action.type === "animate") {
    let actor = Object.hasOwn(stage.actors, action.actor) ? stage.actors[action.actor] : actorDefault(action.actor, scene);
    for (const frame of action.keyframes) {
      const { offset: _offset, ...transform } = frame;
      actor = { ...actor, ...transform };
    }
    return { ...stage, actors: { ...stage.actors, [action.actor]: actor } };
  }
  return stage;
}
function fail(run: StoryRun, error: string): StoryRun { return { ...run, status: "failed", error }; }
function hasExtension(action: StoryAction): boolean { return action.type === "extension" || (action.type === "sequence" || action.type === "parallel") && action.actions.some(hasExtension); }
function rememberSpeaker(run: StoryRun, scene: StoryScene | undefined): StoryRun {
  const current = withStage(run, run.stage);
  const actorId = storyComposition(current, scene).speaker;
  return actorId ? { ...current, lastSpeaker: { sceneId: current.sceneId, actorId } } : current;
}
function withStage(run: StoryRun, stage: StoryStage): StoryRun {
  const previous = run.lastSpeaker?.sceneId === run.sceneId ? stage.actors[run.lastSpeaker.actorId] : undefined;
  return { ...run, stage, ...(run.lastSpeaker && (!previous?.visible || !previous.image) ? { lastSpeaker: undefined } : {}) };
}
function withAction(run: StoryRun, action: StoryAction, scene: StoryScene | undefined): StoryRun {
  if (action.type === "sequence" || action.type === "parallel") return action.actions.reduce((state, child) => withAction(state, child, scene), run);
  return withStage(run, applyStoryAction(run.stage, action, scene));
}
function jump(run: StoryRun, cursor: string): StoryRun { return { ...run, cursor, status: "running", waiting: undefined, error: undefined }; }
function end(run: StoryRun, result?: StoryScalar): StoryRun {
  const frame = run.stack.at(-1);
  return frame ? { ...jump(run, frame.cursor), sceneId: frame.sceneId, stack: run.stack.slice(0, -1), lastSpeaker: undefined }
    : { ...run, status: run.skipping ? "skipped" : "completed", waiting: undefined, result };
}
function drive(initial: StoryRun, context: StoryEngineContext): StoryRun {
  let run = initial;
  const budget = Math.max(1, Math.min(context.stepBudget ?? STORY_LIMITS.automaticSteps, STORY_LIMITS.automaticSteps));
  for (let steps = 0; steps < budget; steps++) {
    if (run.status !== "running") return run;
    const scene = context.resolveScene(run.sceneId);
    if (!scene) return fail(run, `剧情资源不存在：${run.sceneId}`);
    const node = scene.nodes.find(node => node.id === run.cursor);
    if (!node) return fail(run, `剧情节点不存在：${run.cursor}`);
    run = { ...run, sequence: run.sequence + 1 };
    switch (node.type) {
      case "say": {
        if (run.skipping) { run = jump(run, node.next); break; }
        const resolved = { ...node, speaker: node.speaker ? interpolateStoryText(scene.actors && Object.hasOwn(scene.actors, node.speaker) ? scene.actors[node.speaker].name : node.speaker, run.variables) : undefined,
          segments: node.segments.map(segment => "text" in segment ? { text: interpolateStoryText(segment.text, run.variables) } : segment) };
        return rememberSpeaker({ ...run, status: "waiting", waiting: { type: "say", node: resolved } }, scene);
      }
      case "choice": {
        if (run.skipping && node.required === false) {
          if (!node.skipTo) return fail(run, "可跳过选项缺少显式 skipTo");
          run = jump(run, node.skipTo); break;
        }
        const options = node.options.filter(option => !option.when || evaluateStoryCondition(option.when, run, context)).map(option => ({ id: option.id,
          text: interpolateStoryText(option.text, run.variables), enabled: !option.enabledWhen || evaluateStoryCondition(option.enabledWhen, run, context), disabledReason: option.disabledReason ? interpolateStoryText(option.disabledReason, run.variables) : undefined }));
        if (!options.some(option => option.enabled)) return fail(run, `剧情选项没有可用分支：${node.id}`);
        return { ...run, status: "waiting", waiting: { type: "choice", node: { ...node, prompt: node.prompt ? interpolateStoryText(node.prompt, run.variables) : undefined }, options } };
      }
      case "present": {
        // Extensions must receive their own fastForward callback even when this node has never played.
        if (run.skipping && !hasExtension(node.action)) { run = withAction(jump(run, node.next), node.action, scene); break; }
        return { ...run, status: "waiting", waiting: { type: "presentation", node, action: node.action } };
      }
      case "set": {
        const variables = { ...run.variables };
        for (const [key, expression] of Object.entries(node.values)) {
          const value = readStoryValue(expression, run, context);
          if (value === undefined) return fail(run, `剧情变量来源不可用：${key}`);
          variables[key] = value;
        }
        run = { ...jump(run, node.next), variables }; break;
      }
      case "branch": run = jump(run, node.branches.find(branch => evaluateStoryCondition(branch.when, run, context))?.next ?? node.otherwise); break;
      case "call": {
        if (run.stack.length >= STORY_LIMITS.callDepth) return fail(run, "剧情调用栈超过预算");
        const called = context.resolveScene(node.sceneId);
        if (!called) return fail(run, `被调用剧情不存在：${node.sceneId}`);
        run = { ...jump(run, node.entry ?? called.entry), sceneId: node.sceneId, variables: { ...called.variables, ...run.variables }, stack: [...run.stack, { sceneId: run.sceneId, cursor: node.next }], lastSpeaker: undefined }; break;
      }
      case "command": {
        if (run.skipping && node.onSkip === "omit") { run = jump(run, node.next); break; }
        const intent = { ...node.command, id: `${run.id}:${run.sequence}:${run.sceneId}:${node.id}` };
        return { ...run, status: "waiting", waiting: { type: "command", node, intent } };
      }
      case "return": case "end": run = end(run, node.type === "end" ? node.result : undefined); break;
    }
  }
  return run.status === "running" ? fail(run, "剧情自动推进超过步骤预算；请检查分支循环") : run;
}
export function createStoryRun(sceneId: string, context: StoryEngineContext, options: { readonly id?: string; readonly variables?: Readonly<Record<string, StoryScalar>> } = {}): StoryRun {
  const scene = context.resolveScene(sceneId);
  const run: StoryRun = { id: options.id ?? `story:${sceneId}`, sceneId, cursor: scene?.entry ?? "", stack: [], variables: { ...scene?.variables, ...options.variables }, stage: { overlay: 0.5, actors: {} }, status: "running", skipping: false, sequence: 0, choices: [], receipts: [] };
  return drive(run, context);
}
export function advanceStory(run: StoryRun, context: StoryEngineContext): StoryRun {
  if (run.status !== "waiting" || !run.waiting || run.waiting.type === "choice" || run.waiting.type === "command") return run;
  const scene = context.resolveScene(run.sceneId);
  const remembered = rememberSpeaker(run, scene);
  const next = jump(remembered, run.waiting.node.next);
  return drive(run.waiting.type === "presentation" ? withAction(next, run.waiting.action, scene) : next, context);
}
export function chooseStory(run: StoryRun, optionId: string, context: StoryEngineContext): StoryRun {
  if (run.status !== "waiting" || run.waiting?.type !== "choice") return run;
  const node = run.waiting.node;
  const option = node.options.find(option => option.id === optionId);
  if (!option || option.when && !evaluateStoryCondition(option.when, run, context) || option.enabledWhen && !evaluateStoryCondition(option.enabledWhen, run, context)) return run;
  return drive({ ...jump(run, option.next), choices: [...run.choices, { sceneId: run.sceneId, nodeId: node.id, optionId }] }, context);
}
export function skipStory(run: StoryRun, context: StoryEngineContext): StoryRun {
  if (run.status !== "running" && run.status !== "waiting") return run;
  const skipping = { ...run, skipping: true };
  if (run.waiting?.type === "command") return run.waiting.node.onSkip === "omit"
    ? drive(jump(skipping, run.waiting.node.next), context) : skipping;
  if (run.waiting?.type === "presentation" && hasExtension(run.waiting.action)) return skipping;
  if (run.waiting?.type === "say" || run.waiting?.type === "presentation") return advanceStory(skipping, context);
  return drive({ ...skipping, status: "running", waiting: undefined }, context);
}
export function acknowledgeStoryCommand(run: StoryRun, receipt: StoryCommandReceipt, context: StoryEngineContext): StoryRun {
  if (run.status !== "waiting" || run.waiting?.type !== "command" || run.waiting.intent.id !== receipt.id) return run;
  return drive({ ...jump(run, run.waiting.node.next), receipts: run.receipts.some(previous => previous.id === receipt.id) ? run.receipts : [...run.receipts, receipt], variables: { ...run.variables, ...receipt.result } }, context);
}
export function interruptStory(run: StoryRun): StoryRun { return run.status === "running" || run.status === "waiting" || run.status === "failed" ? { ...run, status: "interrupted", waiting: undefined } : run; }
/** Rebuild visible/enabled choices against current public facts without consuming a node visit. */
export function refreshStory(run: StoryRun, context: StoryEngineContext): StoryRun { return run.status === "waiting" && run.waiting?.type === "choice" ? drive({ ...run, status: "running", waiting: undefined, sequence: Math.max(0, run.sequence - 1) }, context) : run; }
/** Re-evaluate a failed semantic node after its unavailable host capability is repaired. */
export function retryStory(run: StoryRun, context: StoryEngineContext): StoryRun { return run.status === "failed" ? drive({ ...run, status: "running", waiting: undefined, error: undefined }, context) : run; }
