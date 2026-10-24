import { assertAuthoringSchema, validateAuthoringValue } from "../content/packages/authoring-schema";
import { CORE_DIALOGUE_PRIMITIVES } from "./facts";
import type { DialoguePrimitive, DialoguePrimitiveDeclaration } from "./types";

export class DialoguePrimitiveRegistry {
  private readonly entries = new Map(CORE_DIALOGUE_PRIMITIVES.map(p => [p.id, p]));
  private readonly listeners = new Set<() => void>();
  subscribeInvalidation(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.revision++; for (const listener of this.listeners) listener(); }
  revision = 0;
  evaluating = 0;
  get(id: string, version: number): DialoguePrimitive | undefined { const p = this.entries.get(id); return p?.apiVersion === version ? p : undefined; }
  registerPackage(packageId: string, declarations: readonly DialoguePrimitiveDeclaration[], implementations: readonly DialoguePrimitive[]): () => void {
    const additions: DialoguePrimitive[] = [];
    const local = new Set<string>();
    for (const declaration of declarations) {
      if (!/^[a-z][a-z0-9-]*$/.test(declaration.id) || local.has(declaration.id)) throw new Error("插件对白原语身份无效或重复");
      local.add(declaration.id);
      assertAuthoringSchema(declaration.parameters);
      const implementation = implementations.find(p => p.id === declaration.id && p.apiVersion === declaration.apiVersion);
      if (!implementation || typeof implementation.read !== "function") throw new Error(`原语未实现：${declaration.id}`);
      const id = `${packageId}#${declaration.id}`;
      if (this.entries.has(id)) throw new Error(`对白原语重复注册：${id}`);
      additions.push(Object.freeze({ ...declaration, id, read: (context: Parameters<DialoguePrimitive["read"]>[0], args: Parameters<DialoguePrimitive["read"]>[1]) => implementation.read(Object.freeze({ ...context, presentation: Object.freeze({ [packageId]: context.presentation?.[packageId] }) }), args) }));
    }
    if (implementations.length !== additions.length) throw new Error("插件实现了未声明或重复的对白原语");
    for (const p of additions) this.entries.set(p.id, p);
    if (additions.length) this.changed();
    let released = false;
    return () => { if (released) return; released = true; for (const p of additions) this.entries.delete(p.id); if (additions.length) this.changed(); };
  }
  validateArgs(id: string, version: number, args: unknown): boolean { const p = this.get(id, version); return !!p && validateAuthoringValue(p.parameters, args).length === 0; }
}
let active = new DialoguePrimitiveRegistry();
export function activeDialogueRegistry(): DialoguePrimitiveRegistry { return active; }
export function installDialogueRegistry(registry: DialoguePrimitiveRegistry): void { active = registry; }
export function clearDialogueRegistry(): void { active = new DialoguePrimitiveRegistry(); }
