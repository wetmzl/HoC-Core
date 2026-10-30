import { describe, expect, it } from "vitest";
import { loadDefaultCharacter } from "../content/characters/loader";
import { createMatch } from "../core/match/reducer";
import { createHand } from "../core/blackjack/hand";
import { createCard } from "../core/blackjack/card";
import { DialogueEngine } from "../dialogue/engine";
import { projectTableView } from "./table-view";
import { displayedHandValueMarkup } from "../presentation/view-helpers";

describe("pure table projection", () => {
  it("keeps the thinking label across redraws and uses the base portrait scale", async () => {
    const character = await loadDefaultCharacter(), initial = createMatch("thinking-view");
    const state = { ...initial, round: { ...initial.round, phase: "turns" as const, currentActor: "opponent" as const } };
    const selection = { ...new DialogueEngine(character.dialogue, character.id).peek(state), portrait: { image: "gesture.png", scale: 1.25 } };
    const input = { state, character, dialogueSelection: selection, dialogueMarkup: "对白", portraitState: "relaxed",
      portraitUrl: character.assets.conflicted, portraitAlt: character.name, thinking: true, skillDrawerOpen: false, debugMarkup: "" };
    const thinking = projectTableView(input).html;
    expect(thinking).toContain('data-step="shifted"');
    expect(thinking).toContain("正在思考中");
    expect(thinking).toContain(`--character-art-scale:${character.portraitScales.table}`);
    expect(projectTableView({ ...input, thinking: false }).html).toContain("--character-art-scale:1.25");
    expect(selection.portrait.image).toBe("gesture.png");
  });
  it("marks natural hands only and keeps opponent feedback private until reveal", async () => {
    const character = await loadDefaultCharacter();
    const initial = createMatch("view-natural-blackjack");
    const hand = createHand([createCard("hearts", "A", "a"), createCard("clubs", "K", "b")]);
    const state = { ...initial, player: { ...initial.player, hand }, opponent: { ...initial.opponent, hand } };
    const input = { state, character, dialogueSelection: new DialogueEngine(character.dialogue, character.id).peek(state),
      dialogueMarkup: "对白", portraitState: "relaxed", portraitUrl: character.assets.relaxed, portraitAlt: character.name,
      skillDrawerOpen: false, displayExpanded: false, debugMarkup: "" };
    expect(projectTableView(input).html.match(/hand-score-base is-blackjack/g)).toHaveLength(1);
    const reveal = projectTableView({ ...input, state: { ...state, round: { ...state.round, phase: "round-reveal" } } });
    expect(reveal.html.match(/hand-score-base is-blackjack/g)).toHaveLength(2);
    expect(reveal.html).toContain("天然21点");
    const ordinary = createHand([createCard("hearts", "7"), createCard("clubs", "7"), createCard("spades", "7")]);
    expect(projectTableView({ ...input, state: { ...state, player: { ...state.player, hand: ordinary } } }).html).not.toContain("is-blackjack");
  });

  it("renders character names as text in the table, waiting notice and prop alt", async () => {
    const base = await loadDefaultCharacter();
    const name = '<img src=x onerror="alert(1)">';
    const character = { ...base, name };
    const initial = createMatch("view-escaped-name");
    const state = { ...initial, round: { ...initial.round, currentActor: "opponent" as const } };
    const input = { state, character, dialogueSelection: new DialogueEngine(character.dialogue, character.id).peek(state),
      dialogueMarkup: "对白", portraitState: "relaxed", portraitUrl: character.assets.relaxed, portraitAlt: character.name,
      skillDrawerOpen: false, debugMarkup: "" };
    const html = projectTableView(input).html;
    expect(html).not.toContain(name);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; 正在观察牌面");
    expect(html).toContain('class="hand-label">&lt;img');
    const trigger = { ...state, round: { ...state.round, phase: "roulette-trigger" as const,
      outcome: { winner: "player" as const, penaltyTarget: "opponent" as const, reason: "comparison" as const, bulletsAdded: 1 } } };
    // The shared portrait alt is escaped as well; no source text can open a new attribute.
    expect(projectTableView({ ...input, state: trigger }).html).not.toContain(name);
  });

  it("keeps score advantages separate from natural feedback and gives busts priority", () => {
    const natural = displayedHandValueMarkup(21, 3, false, true);
    expect(natural).toContain('class="hand-score-base is-blackjack">21');
    expect(natural).toContain('class="hand-score-modifier" aria-hidden="true">+3');
    expect(natural).toContain("比较点数24");
    expect(displayedHandValueMarkup(18, 3, false)).not.toContain("is-blackjack");
    expect(displayedHandValueMarkup(21, 0, true, true)).toContain("is-busted");
    expect(displayedHandValueMarkup(21, 0, true, true)).not.toContain("is-blackjack");
    expect(displayedHandValueMarkup("?", 0, false, true)).not.toContain("is-blackjack");
  });
  it("keeps opponent bust feedback private until reveal and never marks the bonus", async () => {
    const character = await loadDefaultCharacter();
    const initial = createMatch("view-private-bust");
    const hand = createHand([createCard("hearts", "K", "a"), createCard("clubs", "Q", "b"), createCard("spades", "2", "c")]);
    const state = { ...initial, player: { ...initial.player, hand, busted: true }, opponent: { ...initial.opponent, hand, busted: true } };
    const input = { state, character, dialogueSelection: new DialogueEngine(character.dialogue, character.id).peek(state),
      dialogueMarkup: "对白", portraitState: "relaxed", portraitUrl: character.assets.relaxed, portraitAlt: character.name,
      skillDrawerOpen: false, debugMarkup: "" };
    const during = projectTableView(input);
    const reveal = projectTableView({ ...input, state: { ...state, round: { ...state.round, phase: "round-reveal" } } });
    expect(during.html.match(/hand-score-base is-busted/g)).toHaveLength(1);
    expect(reveal.html.match(/hand-score-base is-busted/g)).toHaveLength(2);
    expect(reveal.html).not.toMatch(/hand-score-modifier[^\"]*is-busted/);
    expect(Object.isFrozen(during)).toBe(true);
    expect(state.round.phase).toBe(initial.round.phase);
    expect(projectTableView(input).html).toBe(during.html);
  });
});
