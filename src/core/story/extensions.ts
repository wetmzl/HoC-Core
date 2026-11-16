import type { StoryAction, StoryActionExtension, StoryCommandExtension, StoryExtensionRegistry, StoryScene } from "./types";

const extensionKey = (type: string, apiVersion: number): string => `${type}@${apiVersion}`;
function validateRegistration(extension: StoryCommandExtension): void {
  if (!/^[a-z][a-z0-9-]*(?::|\.)[a-z][a-z0-9._-]*$/.test(extension.type) || !Number.isSafeInteger(extension.apiVersion) || extension.apiVersion < 1 || typeof extension.schema?.safeParse !== "function") throw new Error("剧情扩展必须提供命名空间、正整数 API 版本及参数 Schema");
}
export class StoryExtensions implements StoryExtensionRegistry {
  private readonly actions = new Map<string, StoryActionExtension>();
  private readonly commands = new Map<string, StoryCommandExtension>();
  registerAction(extension: StoryActionExtension): () => void {
    validateRegistration(extension);
    for (const hook of [extension.execute, extension.fastForward, extension.restore, extension.cancel]) if (typeof hook !== "function") throw new Error("剧情动作必须声明执行、快进、恢复和取消方法");
    const key = extensionKey(extension.type, extension.apiVersion);
    if (this.actions.has(key)) throw new Error(`剧情动作已经注册：${key}`);
    this.actions.set(key, extension);
    return () => { if (this.actions.get(key) === extension) this.actions.delete(key); };
  }
  registerCommand(extension: StoryCommandExtension): () => void {
    validateRegistration(extension);
    const key = extensionKey(extension.type, extension.apiVersion);
    if (this.commands.has(key)) throw new Error(`剧情命令已经注册：${key}`);
    this.commands.set(key, extension);
    return () => { if (this.commands.get(key) === extension) this.commands.delete(key); };
  }
  action(type: string, apiVersion: number): StoryActionExtension | undefined { return this.actions.get(extensionKey(type, apiVersion)); }
  command(type: string, apiVersion: number): StoryCommandExtension | undefined { return this.commands.get(extensionKey(type, apiVersion)); }
}
export function visitStoryActions(action: StoryAction, visitor: (action: StoryAction) => void): void {
  visitor(action);
  if (action.type === "sequence" || action.type === "parallel") for (const child of action.actions) visitStoryActions(child, visitor);
}
/** Run against the activated host snapshot before a scene is allowed to reserve the stage. */
export function validateStorySceneCapabilities(scene: StoryScene, registry: StoryExtensionRegistry): readonly string[] {
  const errors: string[] = [];
  for (const node of scene.nodes) {
    if (node.type === "command") {
      const command = registry.command(node.command.type, node.command.apiVersion);
      if (!command) errors.push(`${node.id}: 缺少剧情命令 ${node.command.type}@${node.command.apiVersion}`);
      else if (!command.schema.safeParse(node.command.args).success) errors.push(`${node.id}: 剧情命令参数无效`);
    }
    if (node.type === "present") visitStoryActions(node.action, action => {
      if (action.type !== "extension") return;
      const extension = registry.action(action.typeId, action.apiVersion);
      if (!extension && action.required !== false) errors.push(`${node.id}: 缺少剧情动作 ${action.typeId}@${action.apiVersion}`);
      if (extension && !extension.schema.safeParse(action.args).success) errors.push(`${node.id}: 剧情动作参数无效`);
    });
  }
  return errors;
}
