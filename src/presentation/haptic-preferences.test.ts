import { describe, expect, it, vi } from "vitest";
import { HapticPreferencesStore, HAPTIC_PREFERENCES_KEY } from "./haptic-preferences";

describe("device haptic preferences", () => {
  it("defaults both feedback modes on and persists independent choices across reload", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = new HapticPreferencesStore(storage);
    expect(first.get()).toEqual({ enabled: true, output: true });
    expect(first.update({ output: false })).toBe(true);
    expect(new HapticPreferencesStore(storage).get()).toEqual({ enabled: true, output: false });
    first.update({ enabled: false });
    expect(JSON.parse(values.get(HAPTIC_PREFERENCES_KEY)!)).toEqual({ enabled: false, output: false });
    const detached = first.get() as { enabled: boolean }; detached.enabled = true;
    expect(first.get().enabled).toBe(false);
  });
  it("recovers corrupt fields and supports session choices when device storage fails", () => {
    for (const value of ["bad", "null", "[]", '{"enabled":"yes","output":2}']) {
      expect(new HapticPreferencesStore({ getItem: () => value, setItem: vi.fn() }).get()).toEqual({ enabled: true, output: true });
    }
    const store = new HapticPreferencesStore({ getItem: () => '{"enabled":false}', setItem: () => { throw new Error("quota"); } });
    expect(store.get()).toEqual({ enabled: false, output: true });
    expect(store.update({ output: false })).toBe(false);
    expect(store.get()).toEqual({ enabled: false, output: false });
    expect(new HapticPreferencesStore().update({ output: false })).toBe(false);
  });
});
