import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import { RANKS } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { applyEffects } from "./effects";
import { createAbilityRuntime } from "./runtime";
import { createStandaloneAbilityRegistry } from "./registry";
import type { AbilityInstance, AbilityWorld, Effect, AbilityEventContext } from "./types";
import golden from "./fixtures/primitives-before-v48.json";

const definition = { id: "neutral-copy", name: "Neutral", description: "Neutral", sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: ["neutral"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
  activation: { type: "action", windows: ["owner-turn"], consume: "card" }, rules: [{ id: "copy", trigger: "on-ability-played", effects: [{ type: "grant-skill-card", target: "owner", initialize: false, choices: [{ type: "last-successful-player-skill" }, { type: "self" }] }] }] };
const registry = createStandaloneAbilityRegistry([definition, { ...definition, id: "neutral-other" }], [{ id: "memory", defaultDuration: "match", rules: [] }, { id: "suit", defaultDuration: "round", rules: [] }]);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, key === "catalogVersion" ? "catalog" : canonical(value)])) : value;
function trace(seed: number, scenario: string) {
  const rng = new SeededRng(`compatibility:${seed}`);
  const ability: AbilityInstance = { instanceId: "neutral-instance", definitionId: "neutral-copy", kind: "player-skill", owner: "player", parameters: {}, createdAtSequence: 1 };
  let runtime = createAbilityRuntime(rng.snapshot());
  let world: AbilityWorld = { hands: { player: { cards: [createCard("spades", "7", "p-one"), createCard("hearts", "6", "p-two")] }, opponent: { cards: [createCard("clubs", "9", "o-one"), createDerivedCard("diamonds", RANKS[seed % RANKS.length]!, "o-two", "neutral-source")] } },
    guns: { player: { capacity: 6, bullets: 1 }, opponent: { capacity: 6, bullets: 2 } }, shoe: { cards: [createCard("clubs", "A", "shoe-a"), createCard("clubs", "2", "shoe-two"), createCard("diamonds", "8", "shoe-eight")], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0, statuses: [] };
  let effects: readonly Effect[] = [], event: AbilityEventContext = { trigger: "on-ability-played", sourceEventId: "neutral-event", eventActor: "player" };
  let pending: Parameters<typeof applyEffects>[2] = {};
  if (scenario === "snapshot") { event = { ...event, trigger: "on-round-end" }; effects = [{ type: "assign-status-values", target: "owner", statusDefinitionId: "memory", mode: "replace", stacks: 1, values: { rank: { type: "card-attribute", target: "rival", card: "last-card", attribute: "rank" }, suit: { type: "card-attribute", target: "rival", card: "last-card", attribute: "suit" }, source: { type: "card-attribute", target: "rival", card: "last-card", attribute: "source" }, cardId: { type: "card-attribute", target: "rival", card: "last-card", attribute: "id" } } }]; }
  if (scenario === "memory-rescue") {
    world = { ...world, statuses: [{ owner: "player", statusDefinitionId: "memory", sourceInstanceId: "neutral-instance", stacks: 1, duration: "match", createdAtSequence: 1, parameters: { rank: RANKS[seed % RANKS.length]!, suit: "diamonds", source: "shoe", cardId: "old-card" } }] };
    event = { ...event, trigger: "before-bust-check" }; pending = { bust: { id: "bust", actor: "player", limit: 21 } };
    effects = [{ type: "replace-hand-card-with-derived", target: "owner", card: "last-card", reportResult: false, rank: { type: "value", value: { type: "status-value", target: "owner", statusDefinitionId: "memory", key: "rank" } }, suit: { type: "value", value: { type: "status-value", target: "owner", statusDefinitionId: "memory", key: "suit" } } }, { type: "force-stand", target: "owner" }];
  }
  if (scenario === "majority") { effects = [{ type: "assign-status-values", target: "owner", statusDefinitionId: "suit", mode: "replace", stacks: 1, values: { suit: { type: "hand-dominant-suit", target: "rival", tieBreak: ["spades", "hearts", "diamonds", "clubs"] } } }]; }
  if (scenario === "split") { effects = [{ type: "transform-hand-card", target: "rival", card: "last-card", output: { count: 2, total: { type: "hand-card-value", target: "rival", card: "last-card", aceValue: "eleven" }, suits: "same-color" } }]; }
  if (scenario === "exact-derived") { effects = [{ type: "acquire-card", target: "rival", choices: [{ source: "derived", candidate: { type: "resulting-hand-total-exactly", value: 21 }, pick: "uniform-ability-rng" }] }]; }
  if (scenario === "effective-limit") { effects = [{ type: "acquire-card", target: "rival", reveal: true, choices: [{ source: "derived", candidate: { type: "resulting-hand-total-exactly", value: { type: "bust-limit", target: "rival" } }, evaluationLimit: { type: "bust-limit", target: "rival" }, pick: "uniform-ability-rng" }, { source: "derived", rank: { type: "static", rank: "A" }, suit: { type: "uniform-ability-rng" } }] }]; }
  if (scenario === "physical") { effects = [{ type: "acquire-card", target: "rival", reveal: true, choices: [{ source: "draw-pile", candidate: { type: "resulting-hand-total-exactly", value: { type: "bust-limit", target: "rival" } }, evaluationLimit: { type: "bust-limit", target: "rival" }, pick: "first" }, { source: "draw-pile", pick: "lowest-value" }] }]; }
  if (scenario === "copy-self" || scenario === "copy-last") {
    if (scenario === "copy-last") runtime = { ...runtime, lastPlayedPlayerSkillDefinitionId: "neutral-other", lastPlayedPlayerSkillLevel: 1 };
    effects = [{ type: "grant-skill-card", target: "owner", initialize: false, choices: [{ type: "last-successful-player-skill" }, { type: "self" }] }];
  }
  try {
    const result = applyEffects(effects, { rng, world, runtime, ability, registry, event, bustLimitFor: () => seed % 2 ? 21 : 26 }, pending);
    return canonical({ ...result, events: result.events.filter(event => event.type !== "PENDING_EVENT_MODIFIED"), rng: rng.snapshot() });
  } catch { return { unavailable: true, rng: rng.snapshot() }; }
}
function results() {
  return Array.from({ length: 64 }, (_, seed) => ["snapshot", "memory-rescue", "majority", "split", "exact-derived", "effective-limit", "physical", "copy-self", "copy-last"].map(scenario => ({ seed, scenario, sha256: createHash("sha256").update(JSON.stringify(trace(seed, scenario))).digest("hex") }))).flat();
}
describe("pre-v48 compatibility traces", () => {
  it("preserves original state, acquisitions, public facts and RNG across 576 neutral cases", () => {
    expect(results()).toEqual(golden.cases);
  });
});
