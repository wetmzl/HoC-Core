import { describe, expect, it } from "vitest";
import { SeededRng } from "../rng/seeded";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime, garbageCollectAbilityInstances } from "./runtime";
import { resolveDisplays } from "./displays";
import { AbilityDefinitionSchema } from "./schema";
import { displayChipsMarkup, displayContentMarkup, displayText } from "../../presentation/displays";
import { gunStatusMarkup } from "../../presentation/view-helpers";
import type { AbilityWorld } from "./types";

const status = { id: "neutral-meter-state", defaultDuration: "round", rules: [] };
const query = (key: string) => ({ type: "status-parameter", target: "owner", statusDefinitionId: status.id, key });
const display = { id: "reserve", target: "rival", density: "compact", description: "A finite public resource.",
  content: [{ type: "text", text: "储备 " }, { type: "meter", value: query("reserve"), max: 2, label: "剩余储备" }] };
const definition = { id: "neutral-meter", name: "储备", description: "Neutral meter fixture", sourceKind: "player-skill",
  primaryDomain: "gambler", tags: ["neutral"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
  activation: { type: "action", windows: ["owner-turn"], consume: "card" },
  rules: [{ id: "play", trigger: "on-ability-played", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }], displays: [display] };
function fixture(reserve: unknown = 1) {
  const registry = createStandaloneAbilityRegistry([definition], [status]);
  const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", "source", 1, registry);
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("meter").snapshot()), instance, registry);
  const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [] } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0,
    statuses: reserve === undefined ? [] : [{ statusDefinitionId: status.id, owner: "player", sourceInstanceId: instance.instanceId, stacks: 1,
      duration: "round", parameters: { reserve: reserve as number }, createdAtSequence: 1 }] };
  return { registry, runtime, world };
}
describe("compact resource meters", () => {
  it("projects a stable public resource without mutation", () => {
    const f = fixture(); const before = JSON.stringify(f);
    const [resolved] = resolveDisplays(f.runtime, f.world, f.registry);
    expect(resolved).toMatchObject({ target: "opponent", density: "compact" });
    expect(resolved.content[1]).toEqual({ type: "meter", value: 1, max: 2, label: "剩余储备" });
    expect(displayText(resolved)).toBe("储备 剩余储备 1/2");
    const markup = displayChipsMarkup([resolved], "opponent");
    expect(markup).toContain("status-chip-compact"); expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="1"'); expect(markup).toContain('aria-valuemax="2"');
    expect(markup).toContain('width:50%');
    expect(resolved).not.toHaveProperty("rouletteEffect");
    expect(gunStatusMarkup("对手", 3, 6)).not.toContain("roulette-effect");
    expect(JSON.stringify(f)).toBe(before);
  });
  it("keeps registered meters while consumed sources and round statuses disappear", () => {
    const f = fixture();
    const collected = garbageCollectAbilityInstances({ ...f.runtime, statuses: [] }, [], f.registry);
    expect(collected.instances).toHaveLength(0);
    const [resolved] = resolveDisplays(collected, { ...f.world, statuses: [] }, f.registry);
    expect(resolved.content[1]).toMatchObject({ type: "meter", value: null });
    expect(displayContentMarkup(resolved)).toContain("is-unavailable");
  });
  it("clamps only the visual fill and accessible range, keeping raw readings", () => {
    const f = fixture(5); const [resolved] = resolveDisplays(f.runtime, f.world, f.registry);
    const markup = displayContentMarkup(resolved);
    expect(markup).toContain("5/2"); expect(markup).toContain('width:100%'); expect(markup).toContain('aria-valuenow="2"');
    const negative = { ...resolved, content: [{ type: "meter" as const, value: -2, max: 2, label: "Signed" }] };
    expect(displayContentMarkup(negative)).toContain('width:0%'); expect(displayContentMarkup(negative)).toContain("-2/2");
    for (const max of [0, -1, NaN, Infinity, null]) {
      const unavailable = displayContentMarkup({ ...resolved, content: [{ type: "meter", value: 1, max, label: "Missing" }] });
      expect(unavailable).toContain("is-unavailable"); expect(unavailable).not.toContain('aria-valuenow='); expect(unavailable).toContain('width:0%');
    }
  });
  it("rejects retired decorations, transient values and unknown references", () => {
    const change = (fields: object) => ({ ...definition, displays: [{ ...display, ...fields }] });
    expect(AbilityDefinitionSchema.safeParse(change({ rouletteEffect: { type: "ripple", active: 1 } })).success).toBe(false);
    expect(AbilityDefinitionSchema.safeParse(change({ density: "tiny" })).success).toBe(false);
    for (const value of [{ type: "acquired-card-value" }, { type: "round-point-advantage", target: "owner", round: "current" }])
      expect(AbilityDefinitionSchema.safeParse(change({ content: [{ type: "meter", value, max: 2 }] })).success).toBe(false);
    expect(() => createStandaloneAbilityRegistry([change({ content: [{ type: "meter", value: 1, max: { type: "parameter", key: "missing" } }] })], [status])).toThrow("Unknown display parameter");
    expect(() => createStandaloneAbilityRegistry([change({ content: [{ type: "meter", value: { ...query("reserve"), statusDefinitionId: "missing" }, max: 2 }] })], [status])).toThrow("Unknown display status");
  });
});
