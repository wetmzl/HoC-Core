import { describe, expect, it } from "vitest";
import { createCharacterPackageDraft } from "../../authoring-api";
import { loadHocpkgResources } from "./loader";
import { createHocpkgResourceHandlers } from "./resources";
import type { HocpkgManifest } from "./schema";

const resourceTypes = ["game.player-skill", "game.ai-skill", "game.talent", "game.status"] as const;
type ResourceType = typeof resourceTypes[number];

const legacyRule = {
  id: "move-card", trigger: "after-hand-changed",
  effects: [{ type: "transfer-hand-card", from: "rival", target: "owner", card: "last-card" }]
};
const extendedRule = {
  ...legacyRule,
  effects: [{ type: "transfer-hand-card", from: "rival", target: "owner", card: { type: "matching-transfer", candidate: "reaches-bust-limit", pick: "first" } }]
};

function payloadFor(type: ResourceType, rule: unknown = legacyRule) {
  const definition = {
    id: "neutral-versioned-rule", name: "Neutral rule", description: "Versioned neutral rule language",
    primaryDomain: "cheater", tags: ["neutral"], activation: { type: "automatic" }, rules: [rule]
  };
  if (type === "game.status") return { id: definition.id, defaultDuration: "round", rules: [rule] };
  if (type === "game.player-skill") return {
    definition: { ...definition, sourceKind: "player-skill", skillTags: ["cheater"], drop: { enabled: false, baseWeight: 1 }, stackable: false },
    acquisition: { type: "installed" }
  };
  if (type === "game.talent") return { ...definition, sourceKind: "talent", unlock: { type: "defeat-count", count: 1, label: "Neutral" } };
  return { ...definition, sourceKind: "ai-skill" };
}

async function load(type: ResourceType, apiVersion: number, payload: unknown) {
  const manifest: HocpkgManifest = createCharacterPackageDraft("neutral", "Neutral").manifest;
  manifest.resources = [{ id: "ability", type, apiVersion, entry: "resources/ability.json", requires: [] }];
  manifest.files = [{ path: "resources/ability.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" }];
  return (await loadHocpkgResources(manifest, {
    handlers: createHocpkgResourceHandlers(), readJson: async () => payload
  }))[0];
}

describe("versioned ability resource language", () => {
  for (const type of resourceTypes) {
    const legacyVersion = type === "game.status" ? 1 : 4;
    const currentVersion = legacyVersion + 1;

    it(`keeps existing ${type} rules loadable with both API versions`, async () => {
      expect(await load(type, legacyVersion, payloadFor(type))).toMatchObject({ state: "active" });
      expect(await load(type, currentVersion, payloadFor(type))).toMatchObject({ state: "active" });
    });

    it(`requires the new ${type} API for transfer candidate selection`, async () => {
      expect(await load(type, legacyVersion, payloadFor(type, extendedRule))).toMatchObject({
        state: "invalid", reason: "payload-invalid", error: expect.stringContaining(`资源 API ${currentVersion}`)
      });
      expect(await load(type, currentVersion, payloadFor(type, extendedRule))).toMatchObject({ state: "active" });
    });

    it(`keeps the extended ${type} selector strict`, async () => {
      const rule = { ...extendedRule, effects: [{ ...extendedRule.effects[0], card: { ...extendedRule.effects[0].card, unexpected: true } }] };
      expect(await load(type, currentVersion, payloadFor(type, rule))).toMatchObject({ state: "invalid", reason: "payload-invalid" });
    });

    it(`requires the new ${type} API for held active skill invocation`, async () => {
      const rule = { ...legacyRule, effects: [{ type: "invoke-random-active-skill", target: "rival", filter: { activation: "action", tags: ["neutral"] } }] };
      expect(await load(type, legacyVersion, payloadFor(type, rule))).toMatchObject({ state: "invalid", error: expect.stringContaining(`资源 API ${currentVersion}`) });
      expect(await load(type, currentVersion, payloadFor(type, rule))).toMatchObject({ state: "active" });
    });

    it.each([
      { type: "set-matching-hand-cards-counted", target: "owner", attribute: "source", equals: { type: "literal", value: "derived" }, counted: false },
      { type: "transfer-hand-card", from: "owner", target: "rival", card: "acquired-card" },
      { type: "add-hand-card-tag", target: "owner", card: "last-card", tag: "excluded-from-point-total" }
    ])(`requires the new ${type} API for point counting and acquisition selection: $type`, async effect => {
      const rule = { ...legacyRule, trigger: "after-card-acquired", effects: [effect] };
      expect(await load(type, legacyVersion, payloadFor(type, rule))).toMatchObject({ state: "invalid", error: expect.stringContaining(`资源 API ${currentVersion}`) });
      expect(await load(type, currentVersion, payloadFor(type, rule))).toMatchObject({ state: "active" });
    });

    it.each([
      { type: "actor-stood", target: "rival", expected: true },
      { type: "comparison-would-win", target: "owner" },
      { type: "hand-is-busted", target: "owner" },
      { type: "hand-transfer-candidate-exists", from: "rival", target: "owner", candidate: "reaches-bust-limit" },
      { type: "acquired-card-is-held", target: "owner" }
    ])(`requires the new ${type} API for a nested $type condition`, async condition => {
      const rule = { ...legacyRule, conditions: [{ type: "not", condition }] };
      expect(await load(type, legacyVersion, payloadFor(type, rule))).toMatchObject({ state: "invalid", error: expect.stringContaining(`资源 API ${currentVersion}`) });
      expect(await load(type, currentVersion, payloadFor(type, rule))).toMatchObject({ state: "active" });
    });
  }

  it("checks new primitives inside level overrides", async () => {
    const payload = { ...payloadFor("game.ai-skill"), levels: [{ level: 2, rules: [extendedRule] }] };
    expect(await load("game.ai-skill", 4, payload)).toMatchObject({ state: "invalid", error: expect.stringContaining("资源 API 5") });
    expect(await load("game.ai-skill", 5, payload)).toMatchObject({ state: "active" });
  });

  it("selects held cards with filters and rejects a generated definition pool", async () => {
    const rule = { ...legacyRule, effects: [{ type: "invoke-random-active-skill", target: "rival", definitionIds: ["neutral-active-skill"] }] };
    expect(await load("game.ai-skill", 5, payloadFor("game.ai-skill", rule))).toMatchObject({ state: "invalid", reason: "payload-invalid" });
    const filteredRule = { ...legacyRule, effects: [{ type: "invoke-random-active-skill", target: "rival", filter: { definitionIds: ["neutral-active-skill"] } }] };
    expect(await load("game.ai-skill", 5, payloadFor("game.ai-skill", filteredRule))).toMatchObject({ state: "active" });
  });
});
