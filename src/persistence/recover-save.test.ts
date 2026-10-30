import { describe, expect, it } from "vitest";
import { createDefaultSave } from "./boot";
import { recoverLongTermSave } from "./recover-save";
import { embedSaveInPng, exportSaveJson, importSave } from "./json";
import { validateLongTermSave } from "./schema";
import archived from "../test/fixtures/archived-long-term-save.json";
import { PluginSettingsSession } from "../content/packages/plugin-settings";

describe("best effort durable saves", () => {
  it("isolates damaged fields and records while preserving missing content IDs and opaque originals", () => {
    const raw = {
      ...archived, schemaVersion: 99, futureField: { untouched: [1, true] },
      profile: { ...archived.profile, displayName: 17, selectedSkillTags: ["gambler", "removed", "gambler"], skillDeck: { carried: ["missing/skill", "missing/skill", null], reserve: ["missing/skill", "other/skill"] } },
      settings: { soundEnabled: false, reducedMotion: "bad", pluginSettings: {
        "absent/plugin": { version: 7, values: { flag: true, data: "kept" } },
        "damaged/plugin": { version: 1, values: { valid: 3, nested: { raw: true } } },
        "future/plugin": { version: "next", values: { anything: [1, 2] } }
      } },
      history: [...archived.history.map(item => ({ ...item, removedField: true })), { bad: true }],
      defeats: [...archived.defeats.map(item => ({ ...item, removedField: true })), ...archived.defeats, { opponentId: "gone", timestamp: "invalid" }],
      tutorialProgress: { completedIds: ["plugin:missing/tutorial:intro", "plugin:missing/tutorial:intro", 3] }
    };
    const before = structuredClone(raw);
    const restored = recoverLongTermSave(raw);
    expect(raw).toEqual(before);
    expect(restored.profile).toMatchObject({ displayName: "策展人", matchesPlayed: archived.profile.matchesPlayed, selectedSkillTags: ["gambler"], skillDeck: { carried: ["missing/skill"], reserve: ["other/skill"] } });
    expect(restored.settings).toMatchObject({ soundEnabled: false, reducedMotion: false, pluginSettings: { "absent/plugin": raw.settings.pluginSettings["absent/plugin"], "damaged/plugin": { version: 1, values: { valid: 3 } } } });
    expect(restored.history).toEqual(archived.history);
    expect(restored.defeats).toEqual(archived.defeats);
    expect(restored.tutorialProgress.completedIds).toEqual(["plugin:missing/tutorial:intro"]);
    expect(restored.recovery?.originals).toEqual([before]);
    expect(validateLongTermSave(restored)).toEqual(restored);
    expect(recoverLongTermSave(restored)).toEqual(restored);
  });

  it("keeps originals across JSON and PNG export/import without nesting them on every read", async () => {
    const raw = { ...createDefaultSave(), history: [null], extra: { unknown: true } };
    const restored = recoverLongTermSave(raw);
    expect(await importSave(exportSaveJson(restored))).toEqual(restored);
    const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68,174,66,96,130]);
    const image = embedSaveInPng(png, restored);
    const file = { arrayBuffer: async () => image.buffer } as File;
    expect(await importSave(file)).toEqual(restored);
  });

  it("retains untouched valid saves, unavailable plugin settings and identifiers", () => {
    const save = { ...createDefaultSave(), settings: { soundEnabled: true, reducedMotion: false, pluginSettings: { "absent/plugin": { version: 8, values: { flag: false } } } } };
    expect(recoverLongTermSave(save)).toEqual(save);
    expect(recoverLongTermSave(save).recovery).toBeUndefined();
  });

  it("reads legacy music settings unchanged and roundtrips an explicit music volume", async () => {
    expect(recoverLongTermSave(archived)).toEqual(archived);
    expect(recoverLongTermSave(archived).settings.musicVolume).toBeUndefined();
    const save = createDefaultSave(); save.settings.musicVolume = .37;
    expect(await importSave(exportSaveJson(save))).toEqual(save);
  });

  it.each([-1, 1.01, NaN, "0.4"])("isolates an invalid music volume %s and preserves its original", value => {
    const raw = createDefaultSave();
    const input = { ...raw, settings: { ...raw.settings, soundEnabled: false, musicVolume: value } };
    expect(() => validateLongTermSave(input)).toThrow();
    const restored = recoverLongTermSave(input);
    expect(restored.settings.musicVolume).toBe(.18);
    expect(restored.settings.soundEnabled).toBe(false);
    expect(restored.recovery?.originals).toEqual([input]);
  });

  it("allows changed plugin declarations to use defaults without altering the preserved data", () => {
    const saved = { "changed/plugin": { version: 1, values: { amount: 30 } } };
    const session = new PluginSettingsSession(saved);
    session.register({ packageId: "changed/plugin", title: "Demo", declaration: { version: 2, fields: [{ id: "amount", label: "数量", description: "示例", apply: "immediate", default: 2, schema: { type: "integer", minimum: 0, maximum: 5 } }] } });
    expect(session.values("changed/plugin")).toEqual({ amount: 2 });
    expect(saved["changed/plugin"].values.amount).toBe(30);
  });
});
