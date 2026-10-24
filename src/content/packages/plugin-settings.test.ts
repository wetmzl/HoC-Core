import { expect, it, vi } from "vitest";
import { PluginSettingsDeclarationSchema } from "./plugin-declarations";
import { PluginSettingsSession } from "./plugin-settings";
import { createDefaultSave } from "../../persistence/boot";
import { validateLongTermSave } from "../../persistence/schema";
const declaration = PluginSettingsDeclarationSchema.parse({ version: 1, fields: [
  { id: "volume", label: "音量", description: "强度", apply: "immediate", default: .6, schema: { type: "number", minimum: 0, maximum: 1 } },
  { id: "mode", label: "模式", description: "启动模式", apply: "restart", default: "quiet", schema: { type: "string", enum: ["quiet", "full"] } }
] });
it("isolates packages and commits immediate changes while restart fields retain their startup snapshot", () => {
  const session = new PluginSettingsSession({ "other/demo": { version: 1, values: { volume: .9 } } });
  const release = session.register({ packageId: "test/demo", title: "演示", declaration });
  const listener = vi.fn(), host = session.forPackage("test/demo"), unsubscribe = host.subscribe(listener);
  expect(host.get("volume")).toBe(.6); expect(host.get("constructor")).toBeUndefined();
  const data = session.updated({ "other/demo": { version: 1, values: { volume: .9 } } }, "test/demo", { volume: .2, mode: "full" });
  session.sync(data);
  expect(data["other/demo"].values.volume).toBe(.9); expect(host.get("volume")).toBe(.2); expect(host.get("mode")).toBe("quiet");
  expect(session.values("test/demo").mode).toBe("full"); expect(listener).toHaveBeenCalledOnce();
  unsubscribe(); session.sync(session.updated(data, "test/demo", { volume: .3 })); expect(listener).toHaveBeenCalledOnce();
  release(); expect(host.get("volume")).toBeUndefined(); expect(session.list()).toEqual([]);
  session.register({ packageId: "test/demo", title: "演示", declaration }); expect(host.get("volume")).toBe(.3);
});
it("rejects invalid defaults and writes, and diagnoses incompatible saved values without mutating originals", () => {
  expect(() => PluginSettingsDeclarationSchema.parse({ ...declaration, fields: [{ ...declaration.fields[0], default: 3 }] })).toThrow();
  const stored = { "test/demo": { version: 1, values: { volume: 9 } } }, session = new PluginSettingsSession(stored);
  session.register({ packageId: "test/demo", title: "演示", declaration });
  expect(session.values("test/demo").volume).toBe(.6); expect(session.notices("test/demo")[0]).toContain("不兼容");
  expect(() => session.updated(stored, "test/demo", { volume: 3 })).toThrow();
  expect(() => session.updated(stored, "test/demo", { other: true })).toThrow(); expect(stored["test/demo"].values.volume).toBe(9);
  session.sync({ "test/demo": { version: 2, values: { volume: .2 } } }); expect(session.notices("test/demo")[0]).toContain("版本");
});
it("reads legacy schema 9 and preserves settings for unavailable plugins through save validation", () => {
  const old = createDefaultSave(); expect(validateLongTermSave(old)).toEqual(old);
  const imported = { ...old, settings: { ...old.settings, pluginSettings: { "absent/package": { version: 7, values: { flag: true, amount: 3, label: "原值" } } } } };
  expect(validateLongTermSave(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
});
it("exposes writes only to API 6 and releases package-scoped writers with the runtime", async () => {
  const session = new PluginSettingsSession();
  const unregister = session.register({ packageId: "test/demo", title: "演示", declaration });
  expect(session.forPackage("test/demo").set).toBeUndefined();
  const api = session.forPackage("test/demo", true);
  await expect(api.set!({ volume: .2 })).rejects.toThrow("暂不可写入");
  const writer = vi.fn(async (packageId, values) => { session.sync(session.updated({}, packageId, values)); });
  const release = session.bindWriter(writer);
  await api.set!({ volume: .2 });
  expect(writer).toHaveBeenCalledWith("test/demo", { volume: .2 });
  expect(api.get("volume")).toBe(.2);
  unregister();
  await expect(api.set!({ volume: .3 })).rejects.toThrow();
  release();
});
