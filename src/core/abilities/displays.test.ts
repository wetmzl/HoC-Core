import { afterEach, describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { addAbilityInstance, advanceRoundAbilityTtls, createAbilityRuntime, garbageCollectAbilityInstances } from "./runtime";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, instantiateAbility, installAbilityRegistry } from "./registry";
import { displayCardMarkers, resolveDisplays } from "./displays";
import { AbilityDefinitionSchema } from "./schema";
import { applyEffects } from "./effects";
import { playAbility } from "./engine";
import type { AbilityWorld } from "./types";
import { createMatch, gameReducer } from "../match/reducer";
import { createRuntimeSave } from "../../persistence/boot";
import { RuntimeSaveSchema } from "../../persistence/schema";
import { displayChipsMarkup, displayText } from "../../presentation/displays";
const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));
const status = { id: "example-memory", defaultDuration: "round", rules: [] };
const query = (key: string) => ({ type: "status-parameter", target: "owner", statusDefinitionId: status.id, key });
const definition = {
  id: "example-display", name: "Example", description: "Neutral fixture", sourceKind: "player-skill", primaryDomain: "gambler", tags: ["active-skill-card"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
  parameters: { bonus: { type: "number", default: 0 } }, activation: { type: "action", windows: ["owner-turn"], consume: "card" },
  rules: [{ id: "grant", trigger: "on-ability-played", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }],
  displays: [
    { id: "memory", target: "owner", description: "Saved card", content: [{ type: "text", text: "记忆：" }, { type: "card", rank: query("rank"), suit: query("suit") }], cardMarkers: [{ targets: ["owner", "rival"], suit: query("suit"), type: "memory", label: "同花色" }] },
    { id: "bonus", target: "rival", description: "Bound value", content: [{ type: "text", text: "加成：" }, { type: "number", value: { type: "parameter", key: "bonus" } }] }
  ]
};
const world: AbilityWorld = {
  hands: { player: { cards: [createCard("spades", "Q", "p-q")] }, opponent: { cards: [createCard("spades", "2", "o-2")] } },
  guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0,
  statuses: [{ statusDefinitionId: status.id, owner: "player", sourceInstanceId: "source", stacks: 1, duration: "round", parameters: { rank: "Q", suit: "spades" }, createdAtSequence: 1 }]
};
function fixture() {
  const registry = createStandaloneAbilityRegistry([definition], [status]);
  const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", "source", 1, registry);
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("displays").snapshot()), instance, registry);
  return { registry, instance, runtime: { ...runtime, statuses: world.statuses } };
}
describe("independent declarative displays", () => {
  it("registers multiple targets once, retaining first parameters without changing RNG", () => {
    const { registry, runtime } = fixture();
    const duplicate = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: { bonus: 9 } }, "player", "duplicate", 2, registry);
    const next = addAbilityInstance(runtime, duplicate, registry);
    expect(next.displays).toHaveLength(2); expect(next.displays[1].parameters.bonus).toBe(0);
    const snapshot = JSON.stringify(next); const displays = resolveDisplays(next, world, registry);
    expect(displays.map(displayText)).toEqual(["记忆：Q♠", "加成：0"]);
    expect(displays.map((d) => d.target)).toEqual(["player", "opponent"]); expect(JSON.stringify(next)).toBe(snapshot);
  });
  it("retains displays after active consumption and collection, with missing placeholders", () => {
    const { registry, instance, runtime } = fixture();
    const inputWorld = { ...world, cards: [{ kind: "player-skill" as const, owner: "player" as const, instanceId: instance.instanceId, definitionId: instance.definitionId }], statuses: [] };
    const result = playAbility({ owner: "player", instanceId: instance.instanceId, window: "owner-turn", world: inputWorld, runtime: { ...runtime, statuses: [] }, registry });
    const collected = garbageCollectAbilityInstances(result.runtime, result.world.cards, registry);
    expect(collected.instances).toHaveLength(0); expect(resolveDisplays(collected, result.world, registry).map(displayText)).toEqual(["记忆：—", "加成：0"]);
  });
  it("retains passive displays after TTL expires", () => {
    const registry = createStandaloneAbilityRegistry([{ ...definition, activation: { type: "passive" }, ttl: { type: "rounds", amount: 1 } }], [status]);
    const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", "source", 1, registry);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("ttl").snapshot()), instance, registry);
    const expired = advanceRoundAbilityTtls({ ...runtime, statuses: world.statuses }, [], registry);
    expect(expired.runtime.displays).toEqual(runtime.displays); expect(expired.runtime.statuses).toHaveLength(0);
  });
  it("registers effect-granted cards", () => {
    const { registry, instance, runtime } = fixture();
    const result = applyEffects([{ type: "grant-player-skill-card", target: "owner", source: "last-successful-player-skill", fallback: "self" }], {
      world: { ...world, statuses: [] }, ability: instance, runtime: { ...runtime, instances: [], statuses: [], displays: [] }, registry, rng: new SeededRng("grant"), event: { trigger: "on-ability-played", sourceEventId: "grant" }
    }); expect(result.runtime.displays).toHaveLength(2);
  });
  it("merges matching markers deterministically", () => {
    const { registry, runtime } = fixture(); const displays = resolveDisplays(runtime, world, registry);
    const second = { ...displays[0], key: "second", markers: displays[0].markers.map((marker) => ({ ...marker, type: "second", label: "第二标记" })) };
    expect(displayCardMarkers([...displays, second, ...displays], world)).toEqual({
      "p-q": [{ type: "memory", label: "同花色" }, { type: "second", label: "第二标记" }],
      "o-2": [{ type: "memory", label: "同花色" }, { type: "second", label: "第二标记" }]
    });
  });
  it("rejects transient queries, extra fields, duplicates, and invalid references", () => {
    const change = (value: unknown) => ({ ...definition, displays: [{ ...definition.displays[1], content: [{ type: "number", value }] }] });
    for (const value of [{ type: "hand-total", target: "event-actor" }, { type: "event-hand-card-count", target: "owner" }]) expect(AbilityDefinitionSchema.safeParse(change(value)).success).toBe(false);
    expect(AbilityDefinitionSchema.safeParse({ ...definition, displays: [definition.displays[0], definition.displays[0]] }).success).toBe(false);
    expect(AbilityDefinitionSchema.safeParse({ ...definition, displays: [{ ...definition.displays[0], html: "unsafe" }] }).success).toBe(false);
    expect(() => createStandaloneAbilityRegistry([definition], [])).toThrow("Unknown display status");
    expect(() => createStandaloneAbilityRegistry([change({ type: "parameter", key: "missing" })], [status])).toThrow("Unknown display parameter");
  });
  it("saves after source collection, rejects duplicate registrations, and clears at match end", () => {
    installAbilityRegistry([...original.definitions, definition], [...original.statuses, status], original.catalogVersion);
    const { runtime } = fixture(); const match = createMatch("save-display", { opponentId: "chatgpt" });
    const save = createRuntimeSave({ ...match, abilities: { ...runtime, instances: [], statuses: [] } }, "2026-10-02T00:00:00Z");
    expect(RuntimeSaveSchema.parse(JSON.parse(JSON.stringify(save))).activeMatch.abilities.displays).toEqual(runtime.displays);
    const duplicate = { ...save, activeMatch: { ...save.activeMatch, abilities: { ...save.activeMatch.abilities, displays: [...runtime.displays, runtime.displays[0]] } } };
    expect(RuntimeSaveSchema.safeParse(duplicate).success).toBe(false);
    expect(gameReducer({ ...match, abilities: runtime }, { type: "ESCAPE_MATCH" }).abilities.displays).toHaveLength(0);
    expect(createMatch("new-display", { opponentId: "chatgpt" }).abilities.displays).toHaveLength(0);
  });
  it("escapes text and formats zero, percent and compact faces", () => {
    const { registry, runtime } = fixture(); const display = resolveDisplays(runtime, world, registry)[0];
    const markup = displayChipsMarkup([{ ...display, content: [{ type: "text", text: '<img src=x onerror="bad">' }, { type: "number", value: 0, format: "percent" }, { type: "card", rank: "Q", suit: "hearts", format: "compact" }] }], "player");
    expect(markup).not.toContain('<img src=x'); expect(markup).toContain("&lt;img"); expect(markup).toContain("0%"); expect(markup).toContain("red compact");
  });
});
