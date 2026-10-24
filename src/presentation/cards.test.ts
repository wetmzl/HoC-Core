import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../core/blackjack/card";
import { cardDisplayMarkup, describeCard, describeCards, diamondCardMarker, type CardMarker } from "./cards";

describe("card display descriptions", () => {
  it("renders all four compact knowledge states through the same renderer", () => {
    const card = createCard("hearts", "8", "opaque-card-id");
    const bothKnown = cardDisplayMarkup(describeCard(card, { surface: "front", showRank: true, showSuit: true, variant: "compact" }));
    const rankKnown = cardDisplayMarkup(describeCard(card, { surface: "back", showRank: true, showSuit: false, variant: "compact" }));
    const suitKnown = cardDisplayMarkup(describeCard(card, { surface: "back", showRank: false, showSuit: true, variant: "compact" }));
    const bothUnknown = cardDisplayMarkup(describeCard(card, { surface: "back", showRank: false, showSuit: false, variant: "compact" }));

    expect(bothKnown).toContain('<em class="card-suit">♥</em><b class="card-rank">8</b>');
    expect(bothKnown).toContain("card-compact card-face-compact");
    expect(rankKnown).toContain('<b class="card-rank">8</b>');
    expect(rankKnown).not.toContain("card-suit");
    expect(suitKnown).toContain('<em class="card-suit">♥</em><b class="card-rank card-rank-unknown">?</b>');
    expect(bothUnknown).toContain('<b class="card-unknown">??</b>');
    expect(bothUnknown).toContain('data-card-id="opaque-card-id"');
    expect(bothKnown).not.toContain('class="card ');
    expect(bothKnown).toContain('data-card-surface="front"');
  });

  it("does not derive compact color from a hidden suit", () => {
    const hiddenHeart = cardDisplayMarkup(describeCard(createCard("hearts", "8", "opaque-hidden-id"), {
      surface: "back", showRank: true, showSuit: false, variant: "compact"
    }));
    expect(hiddenHeart).toContain("card-compact card-face-compact neutral");
    expect(hiddenHeart).not.toContain('class="card ');
    expect(hiddenHeart).toContain('data-card-surface="back"');
    expect(hiddenHeart).not.toMatch(/class="[^"]*\b(?:red|black)\b/);
    expect(hiddenHeart).not.toContain("♥");
    expect(hiddenHeart).not.toContain("红桃");
  });

  it("omits automatic tag decoration from compact cards but keeps explicit markers", () => {
    const card = createDerivedCard("hearts", "4", "remembered-card", "memory");
    const compact = describeCard(card, { surface: "front", showRank: true, showSuit: true, variant: "compact" });
    expect(compact.markers).toEqual([]);
    expect(cardDisplayMarkup(compact)).not.toContain("card-marker");
    expect(cardDisplayMarkup(compact)).not.toContain("card-derived");

    const explicit: CardMarker = { type: "intel", position: "top-left", label: "情报标记", visual: { kind: "text", text: "!" } };
    const marked = describeCard(card, { surface: "front", showRank: true, showSuit: true, variant: "compact", markers: [explicit] });
    expect(marked.markers).toEqual([explicit]);
    expect(cardDisplayMarkup(marked)).toContain("card-marker-intel");
  });

  it("uses only the border treatment for derived table cards", () => {
    const card = createDerivedCard("diamonds", "7", "derived-border-only", "fixture");
    const markup = cardDisplayMarkup(describeCard(card, { surface: "front", showRank: true, showSuit: true }));
    expect(markup).toContain("card-derived");
    expect(markup).not.toContain("card-marker");
    expect(markup).not.toContain("衍生牌");
  });

  it("projects surface, rank and suit as independent dimensions", () => {
    const card = createCard("hearts", "8", "physical-8-heart");
    const display = describeCard(card, { surface: "back", showRank: true, showSuit: false });
    expect(display).toMatchObject({ cardId: "physical-8-heart", surface: "back", rank: "8", suit: null, markers: [] });
    const markup = cardDisplayMarkup(display);
    expect(markup).toContain("card-back");
    expect(markup).toContain("card-rank-visible");
    expect(markup).not.toContain("card-suit-visible");
    expect(markup).toContain("card-rank\">8");
    expect(markup).not.toContain("card-suit");
    expect(markup).not.toContain("card-back-emblem");
  });

  it("adds explicit corner markers through one renderer", () => {
    const markers: CardMarker[] = [
      { type: "watch", position: "top-left", label: "监视标记", visual: { kind: "image", src: "/marker.png", alt: "监视" } },
      diamondCardMarker("resonance", "共振牌"),
      { type: "intel", position: "bottom-left", label: "情报标记", visual: { kind: "css", className: "intel-pip" } },
      { type: "lock", position: "bottom-right", label: "锁定标记", visual: { kind: "text", text: "×" } }
    ];
    const card = createDerivedCard("spades", "Q", "derived-q", "example-source");
    const display = describeCard(card, { surface: "back", showRank: false, showSuit: true, markers });
    expect(new Set(display.markers.map((marker) => marker.position))).toEqual(new Set(["top-left", "top-right", "bottom-left", "bottom-right"]));
    const markup = cardDisplayMarkup(display);
    expect(markup).toContain('data-card-id="derived-q"');
    expect(markup).toContain("card-marker-top-left");
    expect(markup).toContain("card-marker-top-right");
    expect(markup).toContain("card-marker-bottom-left");
    expect(markup).toContain("card-marker-bottom-right");
    expect(markup).toContain("card-marker-resonance");
    expect(markup).toContain("共振牌");
    expect(markup).toContain('src="/marker.png"');
    expect(markup).toContain("card-suit-visible");
    expect(markup).toContain("♠");
    expect(markup).not.toContain("card-rank");
    expect(markup).not.toContain("card-back-emblem");
  });

  it("keeps partial hand knowledge attached to card identity", () => {
    const oldPrivate = createCard("hearts", "8", "old-private");
    const replacement = createCard("clubs", "K", "replacement");
    const knownSuitIds = new Set([oldPrivate.id]);
    expect(describeCards([oldPrivate], { suitVisibleCardIds: knownSuitIds })[0]).toMatchObject({ surface: "back", rank: null, suit: "hearts" });
    expect(describeCards([replacement], { suitVisibleCardIds: knownSuitIds })[0]).toMatchObject({ surface: "back", rank: null, suit: null });
  });
});

 it("groups distinct same-corner markers without overlapping their individual positions", () => {
  const card = createCard("spades", "Q", "marker-q");
  const markup = cardDisplayMarkup(describeCard(card, { surface: "back", showRank: false, showSuit: false, markers: [diamondCardMarker("first", "First"), diamondCardMarker("second", "Second")] }));
  expect(markup).toContain('class="card-markers card-markers-top-right"');
  expect(markup).toContain('aria-label="First"'); expect(markup).toContain('aria-label="Second"');
  expect(markup).not.toContain('card-rank');
 });
