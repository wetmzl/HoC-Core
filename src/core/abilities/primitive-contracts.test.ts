import { describe, expect, it } from "vitest";
import { AbilityDefinitionSchema, AbilityDisplaySchema, AbilityRuleSchema, ScalarSchema, StatusDefinitionSchema, createCharacterPackageDraft, validateCharacterPackage } from "../../authoring-api";
import { sha256 } from "../../content/storage/encoding";
import { createStandaloneAbilityRegistry } from "./registry";

const statusId = "example-stage";
const stage = { id: statusId, defaultDuration: "match", rules: [] };
const defenseRule = {
  id: "continue", trigger: "before-defeat",
  conditions: [{ type: "pending-defeat-can-prevent", target: "owner" }, { type: "trigger-result-is", value: "fired" }],
  effects: [
    { type: "prevent-pending-defeat", target: "owner" },
    { type: "assign-status-values", target: "owner", statusDefinitionId: statusId, values: { ["phase"]: { type: "numeric", value: { type: "add", left: { type: "status-number", target: "owner", statusDefinitionId: statusId, key: "phase" }, right: 1 } } } }
  ], limit: { perMatch: 1 }
};
const definition = {
  id: "example-stage-defense", name: "Neutral stage defense", description: "Continue once after a fired chamber.",
  sourceKind: "ai-skill", primaryDomain: "gunslinger", tags: ["stage"], activation: { type: "automatic" },
  rules: [defenseRule, { id: "after", trigger: "after-defeat-prevented", effects: [{ type: "remove-gun-bullets", target: "owner", amount: 1 }] }]
};

async function authoringPackage(ability: unknown = definition, status: unknown = stage) {
  const draft = createCharacterPackageDraft("neutral", "Neutral");
  const dialogue = JSON.parse(draft.files["resources/dialogue.json"]);
  for (const pool of Object.values(dialogue.pools)) (pool as string[]).push("A neutral line.");
  const character = JSON.parse(draft.files["resources/character.json"]);
  character.aiSkills = [{ resourceId: "defense", enabled: true, parameters: {} }];
  const textFiles = {
    ...draft.files,
    "resources/dialogue.json": JSON.stringify(dialogue),
    "resources/character.json": JSON.stringify(character),
    "resources/defense.json": JSON.stringify(ability),
    "resources/stage.json": JSON.stringify(status)
  };
  const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(textFiles).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  for (const name of ["cover", "relaxed", "conflicted", "mocking", "threatened", "unconscious"]) files[`${name}.png`] = new Uint8Array([1, 2, 3]);
  const manifest = {
    ...draft.manifest,
    resources: [...draft.manifest.resources.map(resource => resource.id === "character" ? { ...resource, requires: [...resource.requires, "defense"] } : resource),
      { id: "defense", type: "game.ai-skill", apiVersion: 4, entry: "resources/defense.json", requires: ["stage"] },
      { id: "stage", type: "game.status", apiVersion: 1, entry: "resources/stage.json", requires: [] }],
    files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : "image/png" })))
  };
  return { manifest, readFile: async (path: string) => files[path] };
}

describe("public ability primitive contracts", () => {
  it("validates remaining neutral primitives through a complete package resource graph", async () => {
    const numeric = { type: "status-number", target: "owner", statusDefinitionId: statusId, key: "reserve" };
    const composed = { ...definition, rules: [...definition.rules,
      { id: "remove-inventory", trigger: "on-round-end", conditions: [{ type: "scalar-compare", left: { type: "public-hand-card-suit-count", target: "owner", suit: "spades" }, operator: "gt", right: 0 }], effects: [
        { type: "remove-skill-cards", target: "rival", filter: { primaryDomains: ["gambler"] }, resultKey: "count" },
        { type: "assign-status-values", target: "owner", statusDefinitionId: statusId, values: { ["reserve"]: { type: "numeric", value: { type: "effect-result", key: "count" } } } }
      ] },
      { id: "move-entity", trigger: "before-bust-resolution", effects: [{ type: "transfer-hand-card", from: "owner", target: "rival", card: "last-hit-card" }] },
      { id: "discard", trigger: "after-card-draw", effects: [{ type: "discard-hand-card", target: "owner", card: "last-card" }] },
      { id: "recycle", trigger: "after-card-draw", effects: [{ type: "move-hand-card-to-draw-pile", target: "owner", card: "last-card", position: "bottom" }] },
      { id: "acquired", trigger: "after-card-acquired", effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: statusId, values: { ["reserve"]: { type: "numeric", value: { type: "acquired-card-value", aceValue: "one" } } } }] },
      { id: "previous", trigger: "before-round-resolution", effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: { type: "round-point-advantage", target: "rival", round: "previous" } }] }
    ], displays: [{ id: "reserve", target: "owner", description: "Reserve", density: "compact", content: [{ type: "meter", value: numeric, max: 2, label: "Reserve" }], skillCardMarkers: [{ targets: ["rival"], filter: { primaryDomains: ["gambler"] }, active: { type: "skill-card-count", target: "rival" }, type: "selected", label: "Selected" }] }] };
    await validateCharacterPackage(await authoringPackage(composed));
    expect(() => createStandaloneAbilityRegistry([{ ...composed, displays: [{ ...composed.displays[0], content: [{ type: "number", value: { ...numeric, statusDefinitionId: "missing" } }] }] }], [stage])).toThrow("Unknown display status");
    expect(() => createStandaloneAbilityRegistry([{ ...composed, displays: [{ ...composed.displays[0], content: [{ type: "meter", value: 1, max: { type: "parameter", key: "missing" } }] }] }], [stage])).toThrow("Unknown display parameter");
  });

  it("rejects transient facts even inside nested display meters and surface effects", () => {
    const transient = [{ type: "acquired-card-value" }, { type: "round-point-advantage", target: "owner", round: "current" }];
    for (const value of transient) {
      expect(AbilityDisplaySchema.safeParse({ id: "reserve", target: "owner", description: "Reserve", content: [{ type: "meter", value: 1, max: { type: "add", left: value, right: 1 } }] }).success).toBe(false);
      expect(AbilityDisplaySchema.safeParse({ id: "reserve", target: "owner", description: "Reserve", content: [{ type: "number", value }] }).success).toBe(false);
    }
    expect(ScalarSchema.safeParse({ type: "round-point-advantage", target: "rival", round: "previous" }).success).toBe(true);
    expect(ScalarSchema.safeParse({ type: "acquired-card-value", aceValue: "twelve" }).success).toBe(false);
  });

  it("accepts only a safe positive definition-wide player acquisition limit", () => {
    const limited = { ...definition, sourceKind: "player-skill", skillTags: ["gunslinger"], drop: { enabled: true, baseWeight: 1 }, stackable: false, acquisitionLimit: { perMatch: 1 } };
    expect(AbilityDefinitionSchema.safeParse(limited).success).toBe(true);
    for (const perMatch of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(AbilityDefinitionSchema.safeParse({ ...limited, acquisitionLimit: { perMatch } }).success).toBe(false);
    expect(AbilityDefinitionSchema.safeParse({ ...definition, acquisitionLimit: { perMatch: 1 } }).success).toBe(false);
  });

  it("loads a neutral continuation rule through the public authoring API and full package graph", async () => {
    expect(AbilityDefinitionSchema.parse(definition).rules).toEqual(definition.rules);
    expect(StatusDefinitionSchema.parse(stage)).toEqual(stage);
    await validateCharacterPackage(await authoringPackage());
  });

  it.each(["fired", "empty-chamber", "misfire"])("accepts the concrete trigger result %s", value => {
    expect(AbilityRuleSchema.safeParse({ ...defenseRule, conditions: [{ type: "trigger-result-is", value }] }).success).toBe(true);
  });

  it.each([
    { type: "floor", value: { type: "divide", left: 9, right: 2 } },
    { type: "ceil", value: { type: "divide", left: 9, right: 2 } },
    { type: "round", value: -1.5 },
    { type: "abs", value: { type: "modulo", left: -7, right: 3 } }
  ])("accepts nested scalar expression $type through public schema", value => {
    expect(ScalarSchema.parse(value)).toEqual(value);
  });

  it.each([
    { type: "floor", value: 1, left: 2 },
    { type: "divide", left: 1 },
    { type: "modulo", left: 1, right: 2, precision: 0 },
    { type: "round", value: Number.POSITIVE_INFINITY }
  ])("rejects malformed scalar expression $type", value => {
    expect(ScalarSchema.safeParse(value).success).toBe(false);
  });

  it("accepts status-owner for status rules but rejects it in stable display facts", () => {
    const rule = { ...defenseRule, effects: [{ type: "assign-status-values", target: "status-owner", statusDefinitionId: statusId, values: { ["phase"]: { type: "numeric", value: 2 } } }] };
    expect(StatusDefinitionSchema.safeParse({ ...stage, rules: [rule] }).success).toBe(true);
    expect(AbilityDefinitionSchema.safeParse({ ...definition, displays: [{ id: "phase", target: "owner", description: "Phase", content: [{ type: "number", value: { type: "status-number", target: "status-owner", statusDefinitionId: statusId, key: "phase" } }] }] }).success).toBe(false);
  });

  it.each([
    { ...defenseRule, conditions: [{ type: "trigger-result-is", value: "cancelled" }] },
    { ...defenseRule, conditions: [{ type: "pending-defeat-can-prevent", target: "owner", once: true }] },
    { ...defenseRule, effects: [{ type: "prevent-pending-defeat", target: "owner", stage: 2 }] },
    { ...defenseRule, effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: statusId, values: { [""]: { type: "numeric", value: 2 } } }] }
  ])("rejects unknown results, extra fields and empty numeric keys", rule => {
    expect(AbilityRuleSchema.safeParse(rule).success).toBe(false);
  });

  it("validates numeric status references in base rules, level overrides and activation availability", () => {
    expect(() => createStandaloneAbilityRegistry([definition], [])).toThrow("Unknown status");
    const unknown = { type: "assign-status-values", target: "owner", statusDefinitionId: "missing", values: { ["phase"]: { type: "numeric", value: 2 } } };
    expect(() => createStandaloneAbilityRegistry([{ ...definition, levels: [{ level: 2, rules: [{ ...defenseRule, effects: [unknown] }] }] }], [stage])).toThrow("Unknown status");
    const availability = { type: "scalar-compare", left: { type: "floor", value: { type: "status-number", target: "owner", statusDefinitionId: "missing", key: "phase" } }, operator: "gt", right: 0 };
    expect(() => createStandaloneAbilityRegistry([{ ...definition, activation: { type: "action", windows: ["owner-turn"], consume: "none", availability: [availability] } }], [stage])).toThrow("Unknown status");
  });

  it("checks nested numeric parameter references and complete packages reject an unknown status", async () => {
    const invalidRule = { ...defenseRule, effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: statusId, values: { ["phase"]: { type: "numeric", value: { type: "floor", value: { type: "divide", left: { type: "parameter", key: "missing" }, right: 2 } } } } }] };
    expect(() => createStandaloneAbilityRegistry([{ ...definition, rules: [invalidRule] }], [stage])).toThrow("Unknown parameter");
    await expect(validateCharacterPackage(await authoringPackage(definition, { ...stage, id: "other-stage" }))).rejects.toThrow("Unknown status");
  });
});
