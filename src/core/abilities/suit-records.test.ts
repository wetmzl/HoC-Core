import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import { SUITS, type Suit } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import { resolveDisplays } from "./displays";
import { AbilityDefinitionSchema } from "./schema";
import { displayChipsMarkup, displayText } from "../../presentation/displays";
import type { DisplayValue } from "./display-types";
import type { AbilityWorld } from "./types";

const handValues = Object.fromEntries(SUITS.map(suit => [suit, { type: "add", left: { type: "hand-card-suit-count", target: "owner", suit }, right: { type: "hand-card-suit-count", target: "rival", suit } }])) as Record<Suit, DisplayValue>;
function fixture(owner: "player" | "opponent" = "player", values = handValues) {
  const definition = { id: "example-suit-display", name: "Suit set", description: "Generic fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["display"], activation: { type: "automatic" }, rules: [], displays: [{ id: "suits", target: "rival", description: "Projected values", content: [{ type: "text", text: "Suits" }, { type: "suit-record", values }, { type: "number", value: 42 }] }] };
  const registry = createStandaloneAbilityRegistry([definition], []);
  const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, owner, "source", 1, registry, "ai-skill");
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("suits").snapshot()), instance, registry);
  const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0, statuses: [] };
  return { definition, registry, runtime, world };
}
describe("generic suit display sets", () => {
  for (const owner of ["player", "opponent"] as const) {
    it.each([0, 1, 2, 3, 4])(`projects the table union for ${owner}: %i suits`, count => {
      const f = fixture(owner);
      const cards = SUITS.slice(0, count).map((suit, index) => createCard(suit, "2", `card-${index}`));
      const world = { ...f.world, hands: { player: { cards: cards.slice(0, 2) }, opponent: { cards: cards.slice(2) } } };
      const before = JSON.stringify({ world, runtime: f.runtime });
      const display = resolveDisplays(f.runtime, world, f.registry)[0];
      expect(display.content[1]).toEqual({ type: "suit-record", suits: SUITS.slice(0, count) });
      expect(display.target).toBe(owner === "player" ? "opponent" : "player");
      expect(displayText(display)).toBe(`Suits${count}/442`);
      const markup = displayChipsMarkup([display], display.target);
      expect(markup.match(/class="suit-record-cell/g)).toHaveLength(4);
      expect(markup.match(/ is-recorded/g)?.length ?? 0).toBe(count);
      expect(markup).toContain("display-number");
      expect(resolveDisplays(f.runtime, world, f.registry)[0]).toEqual(display);
      expect(JSON.stringify({ world, runtime: f.runtime })).toBe(before);
    });
  }
  it("includes derived cards, deduplicates suits and follows removal and transfer", () => {
    const f = fixture();
    const world = { ...f.world, hands: { player: { cards: [createCard("spades", "2"), createCard("spades", "3")] }, opponent: { cards: [createDerivedCard("clubs", "4", "derived")] } } };
    const projected = (input: AbilityWorld) => resolveDisplays(f.runtime, input, f.registry)[0].content[1];
    expect(projected(world)).toEqual({ type: "suit-record", suits: ["spades", "clubs"] });
    const transferred = { ...world, hands: { player: { cards: [...world.hands.player.cards, ...world.hands.opponent.cards] }, opponent: { cards: [] } } };
    expect(projected(transferred)).toEqual(projected(world));
    expect(projected({ ...transferred, hands: { player: { cards: world.hands.player.cards }, opponent: { cards: [] } } })).toEqual({ type: "suit-record", suits: ["spades"] });
  });
  it("lights only true and positive numbers, with missing parameters and strings dim", () => {
    const f = fixture("player", { spades: { type: "constant", value: true }, hearts: 2, diamonds: { type: "constant", value: "true" }, clubs: { type: "hand-card-attribute", target: "owner", card: "first-private-card", attribute: "suit" } });
    expect(resolveDisplays(f.runtime, f.world, f.registry)[0].content[1]).toEqual({ type: "suit-record", suits: ["spades", "hearts"] });
    const dim = fixture("opponent", { spades: 0, hearts: -1, diamonds: { type: "constant", value: false }, clubs: { type: "hand-card-attribute", target: "owner", card: "last-card", attribute: "rank" } });
    expect(resolveDisplays(dim.runtime, dim.world, dim.registry)[0].content[1]).toEqual({ type: "suit-record", suits: [] });
  });
  it("requires exactly four stable queries and validates nested references", () => {
    const f = fixture();
    const change = (values: unknown) => ({ ...f.definition, displays: [{ ...f.definition.displays[0], content: [{ type: "suit-record", values }] }] });
    const { clubs: _clubs, ...missing } = handValues;
    for (const values of [missing, { ...handValues, extra: 1 }, { ...handValues, clubs: { type: "hand-card-suit-count", target: "event-actor", suit: "clubs" } }]) expect(AbilityDefinitionSchema.safeParse(change(values)).success).toBe(false);
    expect(() => createStandaloneAbilityRegistry([change({ ...handValues, clubs: { type: "parameter", key: "missing" } })], [])).toThrow("Unknown display parameter");
  });
});
