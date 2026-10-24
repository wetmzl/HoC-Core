import { validateAuthoringValue } from "./authoring-schema";
import type { PluginSettingsApi, PluginSettingsData, PluginSettingsDeclaration, PluginSettingValue } from "./plugin-declarations";
export interface PluginSettingsEntry { readonly packageId: string; readonly title: string; readonly declaration: PluginSettingsDeclaration }
export class PluginSettingsSession {
  private writer?: (packageId: string, values: Readonly<Record<string, PluginSettingValue>>) => Promise<void>;
  bindWriter(writer: (packageId: string, values: Readonly<Record<string, PluginSettingValue>>) => Promise<void>): () => void { this.writer = writer; return () => { if (this.writer === writer) this.writer = undefined; }; }
  private readonly entries = new Map<string, PluginSettingsEntry>();
  private readonly listeners = new Map<string, Set<(values: Readonly<Record<string, PluginSettingValue>>) => void>>();
  private readonly restartValues = new Map<string, Record<string, PluginSettingValue>>();
  constructor(private data: PluginSettingsData = {}) {}
  list(): readonly PluginSettingsEntry[] { return [...this.entries.values()]; }
  register(entry: PluginSettingsEntry): () => void {
    if (this.entries.has(entry.packageId)) throw new Error("插件设置重复注册");
    this.entries.set(entry.packageId, entry);
    this.restartValues.set(entry.packageId, this.values(entry.packageId));
    return () => { this.entries.delete(entry.packageId); this.listeners.delete(entry.packageId); this.restartValues.delete(entry.packageId); };
  }
  values(packageId: string, runtime = false): Record<string, PluginSettingValue> {
    const entry = this.entries.get(packageId);
    if (!entry) return {};
    const stored = this.data[packageId];
    return Object.fromEntries(entry.declaration.fields.map(field => {
      const candidate = stored?.version === entry.declaration.version ? stored.values[field.id] : undefined;
      const value = candidate !== undefined && !validateAuthoringValue(field.schema, candidate).length ? candidate : field.default;
      return [field.id, runtime && field.apply === "restart" ? this.restartValues.get(packageId)?.[field.id] ?? value : value];
    }));
  }
  notices(packageId: string): string[] {
    const entry = this.entries.get(packageId), stored = this.data[packageId];
    if (!entry || !stored) return [];
    if (stored.version !== entry.declaration.version) return ["设置版本已变化，当前使用默认值；保存后更新本插件设置。"];
    return entry.declaration.fields.filter(f => stored.values[f.id] !== undefined && validateAuthoringValue(f.schema, stored.values[f.id]).length).map(f => `${f.label} 的旧值不兼容，当前使用默认值。`);
  }
  updated(data: PluginSettingsData, packageId: string, values: Readonly<Record<string, PluginSettingValue>>): PluginSettingsData {
    const entry = this.entries.get(packageId);
    if (!entry) throw new Error("插件设置不可用");
    const fields = new Map(entry.declaration.fields.map(f => [f.id, f]));
    for (const [id, value] of Object.entries(values)) {
      const field = fields.get(id);
      if (!field) throw new Error(`未知设置：${id}`);
      const issue = validateAuthoringValue(field.schema, value)[0];
      if (issue) throw new Error(`${field.label}：${issue.message}`);
    }
    const defaults = Object.fromEntries(entry.declaration.fields.map(f => [f.id, f.default]));
    return { ...data, [packageId]: { version: entry.declaration.version, values: { ...defaults, ...values } } };
  }
  sync(data: PluginSettingsData): void {
    const before = new Map(this.list().map(e => [e.packageId, JSON.stringify(this.values(e.packageId, true))]));
    this.data = data;
    for (const entry of this.list()) {
      const values = this.values(entry.packageId, true);
      if (before.get(entry.packageId) !== JSON.stringify(values)) for (const listener of this.listeners.get(entry.packageId) ?? []) {
        try { listener(Object.freeze(values)); } catch (error) { console.warn("插件设置订阅失败", error); }
      }
    }
  }
  forPackage(packageId: string, writable = false): PluginSettingsApi {
    return Object.freeze({
      ...(writable ? { set: async (values: Readonly<Record<string, PluginSettingValue>>) => { if (!this.writer || !this.entries.has(packageId)) throw new Error("插件设置暂不可写入"); await this.writer(packageId, values); } } : {}),
      get: (id: string) => { const values = this.values(packageId, true); return Object.hasOwn(values, id) ? values[id] : undefined; },
      subscribe: (listener: (values: Readonly<Record<string, PluginSettingValue>>) => void) => {
        const listeners = this.listeners.get(packageId) ?? new Set(); this.listeners.set(packageId, listeners); listeners.add(listener);
        return () => { listeners.delete(listener); };
      }
    });
  }
}
