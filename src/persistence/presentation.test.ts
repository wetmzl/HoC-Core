import { expect, it, vi } from "vitest";
import { MemoryPresentationDriver, NativePresentationDriver, PresentationStore } from "./presentation";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";
const declaration = { apiVersion: 1, schema: { type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false }, initial: { count: 0 } };
it("serializes separate package/game state and sequences, flushes, and deletes only the finished game", async () => {
  const driver = new MemoryPresentationDriver(), writes: unknown[] = [];
  const original = driver.write.bind(driver); driver.write = async records => { writes.push(structuredClone(records)); await original(records); };
  const store = new PresentationStore(driver); await store.load();
  store.set("one", "test/a", declaration, { count: 1 }); store.set("one", "test/b", declaration, { count: 2 }); store.set("two", "test/a", declaration, { count: 3 });
  expect(store.nextSequence("one", "test/a", declaration)).toBe(1); expect(store.nextSequence("one", "test/a", declaration)).toBe(2);
  expect(() => store.set("one", "test/a", declaration, { count: -1 })).toThrow();
  await store.flush(); expect(writes).toHaveLength(5);
  const restored = new PresentationStore(driver); await restored.load(); expect(restored.get("one", "test/a", declaration)).toEqual({ count: 1 }); expect(restored.nextSequence("one", "test/a", declaration)).toBe(3);
  expect(Object.isFrozen(restored.get("one", "test/a", declaration))).toBe(true);
  restored.clearMatch("one"); await restored.flush(); expect(Object.keys(driver.records)).toEqual([JSON.stringify(["two", "test/a"])]);
});
it("resets corrupt/unsupported records with a localized diagnostic and accepts subsequent writes", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), driver = new MemoryPresentationDriver();
  driver.records[JSON.stringify(["one", "test/a"])] = { apiVersion: 1, sequence: 10, state: { count: "bad" } };
  const store = new PresentationStore(driver); await store.load(); expect(store.get("one", "test/a", declaration)).toEqual({ count: 0 }); expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ matchId: "one", packageId: "test/a" }));
  store.set("one", "test/a", declaration, { count: 3 }); expect(store.nextSequence("one", "test/a", declaration)).toBe(1); await store.flush(); warn.mockRestore();
});
it("native independent A/B slots recover from corruption without touching domain save files", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), files = new Map<string, string>([["presentation/slot-a.json", "broken"], ["presentation/slot-b.json", "broken"], ["saves/slot-a.json", "domain-marker"]]);
  const port = { async readFile({ path }: { path: string }) { if (!files.has(path)) throw Error("not found"); return { data: files.get(path)! }; }, async writeFile({ path, data }: { path: string; data: string }) { files.set(path, data); } };
  const native = new NativePresentationDriver(new CapacitorFileSaveStorageDriver(port, () => "2026-10-13", "presentation", true)), store = new PresentationStore(native); await store.load();
  store.set("one", "test/a", declaration, { count: 2 }); await store.flush();
  expect(files.get("saves/slot-a.json")).toBe("domain-marker");
  const restored = new PresentationStore(native); await restored.load(); expect(restored.get("one", "test/a", declaration)).toEqual({ count: 2 }); expect(warn).toHaveBeenCalled(); warn.mockRestore();
});
