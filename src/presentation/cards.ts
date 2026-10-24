import { cardSource, cardSuit, cardRank } from "../core/blackjack/card";
import type { Card, Rank, Suit } from "../core/blackjack/types";

export type CardSurface = "front" | "back";
export type CardMarkerPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CardMarkerVisual =
  | { readonly kind: "css"; readonly className: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly src: string; readonly alt: string };

export interface CardMarker {
  readonly type: string;
  readonly position: CardMarkerPosition;
  readonly label: string;
  readonly visual: CardMarkerVisual;
}

export interface CardDisplayDescription {
  readonly cardId: string;
  readonly source: Card["attributes"]["source"];
  readonly tags: readonly string[];
  readonly surface: CardSurface;
  readonly rank: Rank | null;
  readonly suit: Suit | null;
  readonly markers: readonly CardMarker[];
  readonly variant?: "table" | "compact";
}

export interface CardVisibility {
  readonly surface: CardSurface;
  readonly showRank: boolean;
  readonly showSuit: boolean;
  readonly markers?: readonly CardMarker[];
  readonly variant?: CardDisplayDescription["variant"];
}

export interface HandCardKnowledge {
  readonly revealAll?: boolean;
  readonly faceUpCardIds?: ReadonlySet<string>;
  readonly rankVisibleCardIds?: ReadonlySet<string>;
  readonly suitVisibleCardIds?: ReadonlySet<string>;
  readonly markersByCardId?: Readonly<Record<string, readonly CardMarker[]>>;
  readonly variant?: CardDisplayDescription["variant"];
}

export function diamondCardMarker(type: string, label: string): CardMarker {
  return {
    type,
    position: "top-right",
    label,
    visual: { kind: "text", text: "◇" }
  };
}

export function describeCard(card: Card, visibility: CardVisibility): CardDisplayDescription {
  return {
    cardId: card.id,
    source: cardSource(card),
    tags: [...card.tags],
    surface: visibility.surface,
    rank: visibility.showRank ? cardRank(card) : null,
    suit: visibility.showSuit ? cardSuit(card) : null,
    markers: [...(visibility.markers ?? [])],
    variant: visibility.variant
  };
}

/** Converts observer knowledge into renderer-ready descriptions without card-kind branches. */
export function describeCards(cards: readonly Card[], knowledge: HandCardKnowledge): readonly CardDisplayDescription[] {
  return cards.map((card) => {
    const faceUp = knowledge.revealAll === true || knowledge.faceUpCardIds?.has(card.id) === true;
    return describeCard(card, {
      surface: faceUp ? "front" : "back",
      showRank: faceUp || knowledge.rankVisibleCardIds?.has(card.id) === true,
      showSuit: faceUp || knowledge.suitVisibleCardIds?.has(card.id) === true,
      markers: knowledge.markersByCardId?.[card.id],
      variant: knowledge.variant
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

export function suitPresentation(suit: Suit): { readonly symbol: string; readonly label: string; readonly red: boolean } {
  if (suit === "hearts") return { symbol: "♥", label: "红桃", red: true };
  if (suit === "diamonds") return { symbol: "♦", label: "方块", red: true };
  if (suit === "clubs") return { symbol: "♣", label: "梅花", red: false };
  return { symbol: "♠", label: "黑桃", red: false };
}

function markerMarkup(marker: CardMarker): string {
  const base = `card-marker card-marker-${marker.position} card-marker-${escapeHtml(marker.type)}`;
  if (marker.visual.kind === "image") return `<span class="${base}" aria-label="${escapeHtml(marker.label)}"><img src="${escapeHtml(marker.visual.src)}" alt="${escapeHtml(marker.visual.alt)}"></span>`;
  if (marker.visual.kind === "text") return `<span class="${base}" aria-label="${escapeHtml(marker.label)}">${escapeHtml(marker.visual.text)}</span>`;
  return `<span class="${base} ${escapeHtml(marker.visual.className)}" aria-label="${escapeHtml(marker.label)}"></span>`;
}

function markersMarkup(markers: readonly CardMarker[]): string {
  const positions = [...new Set(markers.map((marker) => marker.position))];
  return positions.map((position) => {
    const entries = markers.filter((marker) => marker.position === position);
    const content = entries.map(markerMarkup).join("");
    return entries.length === 1 ? content : `<span class="card-markers card-markers-${position}">${content}</span>`;
  }).join("");
}

/** The sole HTML renderer for actual playing-card entities. */
export function cardDisplayMarkup(display: CardDisplayDescription): string {
  const suit = display.suit ? suitPresentation(display.suit) : null;
  const compact = display.variant === "compact";
  const visibleFacts = [
    display.rank ? `点数${display.rank}` : compact ? "点数未知" : "",
    suit ? `花色${suit.label}` : compact ? "花色未知" : ""
  ].filter(Boolean).join("，");
  const surfaceLabel = display.surface === "front" ? "正面" : "牌背";
  const markerLabels = display.markers.map((marker) => marker.label).join("、");
  const aria = [surfaceLabel, visibleFacts, markerLabels].filter(Boolean).join("，");
  const face = compact
    ? suit
      ? `<em class="card-suit">${suit.symbol}</em><b class="card-rank${display.rank ? "" : " card-rank-unknown"}">${display.rank ? escapeHtml(display.rank) : "?"}</b>`
      : display.rank
        ? `<b class="card-rank">${escapeHtml(display.rank)}</b>`
        : `<b class="card-unknown">??</b>`
    : `${suit ? `<em class="card-suit">${suit.symbol}</em>` : ""}${display.rank ? `<b class="card-rank">${escapeHtml(display.rank)}</b>` : ""}`;
  const classes = (compact ? [
    "card-compact",
    "card-face-compact",
    suit ? (suit.red ? "red" : "black") : "neutral",
    display.rank ? "card-rank-visible" : "",
    suit ? "card-suit-visible" : ""
  ] : [
    "card",
    `card-${display.surface}`,
    suit?.red ? "red" : "black",
    display.rank ? "card-rank-visible" : "",
    suit ? "card-suit-visible" : "",
    cardHasDisplayTag(display, "derived") ? "card-derived" : ""
  ]).filter(Boolean).join(" ");
  return `<span class="${classes}" data-card-id="${escapeHtml(display.cardId)}" data-card-source="${display.source}" data-card-surface="${display.surface}" aria-label="${escapeHtml(aria)}">${compact ? face : `<span class="card-surface" aria-hidden="true">${face}</span>`}${markersMarkup(display.markers)}</span>`;
}

function cardHasDisplayTag(display: CardDisplayDescription, tag: string): boolean {
  return display.tags.includes(tag);
}
