import type { ResolvedDisplay, ResolvedDisplayNode } from "../core/abilities/displays";
import type { AbilityActor } from "../core/abilities/types";
import { RANKS, SUITS, type Suit } from "../core/blackjack/types";
import { suitPresentation } from "./cards";
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
// Fixed shapes avoid platform fonts substituting emoji or clipping suit glyphs.
const suitPaths: Record<Suit, string> = {
  spades: "M12 2C9 6 3 9 3 14a5 5 0 0 0 8 4c0 2-1 3-2 4h6c-1-1-2-2-2-4a5 5 0 0 0 8-4c0-5-6-8-9-12Z",
  hearts: "M12 22 3 13C-3 6 6-2 12 5c6-7 15 1 9 8Z",
  diamonds: "M12 1 22 12 12 23 2 12Z",
  clubs: "M12 2a5 5 0 0 0-4 8 5 5 0 1 0 3 8c0 2-1 3-2 4h6c-1-1-2-2-2-4a5 5 0 1 0 3-8 5 5 0 0 0-4-8Z"
};
function suitMarkup(suit: Suit): string {
  return `<svg class="display-suit-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${suitPaths[suit]}"></path></svg><span class="display-suit-text">${suitPresentation(suit).symbol}</span>`;
}
export function displayNodeText(node: ResolvedDisplayNode): string {
  if (node.type === "text") return node.text;
  if (node.type === "meter") return `${node.label} ${node.value === null || node.max === null ? "—" : `${node.value}/${node.max}`}`;
  if (node.type === "suit-record") return `${node.suits.length}/4`;
  if (node.type === "rank-record") return `${node.ranks.length}/13`;
  if (node.type === "number") return node.value === null ? "—" : node.format === "percent" ? `${Math.round(node.value * 100)}%` : String(node.value);
  if (node.type === "suit") return node.value === null ? "—" : suitPresentation(node.value).symbol;
  return node.rank === null || node.suit === null ? "—" : `${node.rank}${suitPresentation(node.suit).symbol}`;
}
export function displayText(display: ResolvedDisplay): string { return display.content.map(displayNodeText).join(""); }
export function displayContentMarkup(display: ResolvedDisplay): string {
  return display.content.map((node) => {
    if (node.type === "meter") {
      const valid = node.value !== null && node.max !== null && Number.isFinite(node.value) && Number.isFinite(node.max) && node.max > 0;
      const value = valid ? Math.max(0, Math.min(node.max!, node.value!)) : 0;
      const fill = valid ? value / node.max! * 100 : 0;
      const text = escape(displayNodeText(node));
      return `<span class="display-meter${valid ? "" : " is-unavailable"}" role="${valid ? "meter" : "img"}" aria-label="${escape(node.label)}${valid ? "" : "：数据不可用"}"${valid ? ` aria-valuemin="0" aria-valuemax="${node.max}" aria-valuenow="${value}" aria-valuetext="${text}"` : ""}><span class="display-meter-track" aria-hidden="true"><i style="width:${fill}%"></i></span><span class="display-meter-reading">${valid ? `${node.value}/${node.max}` : "—"}</span></span>`;
    }
    if (node.type === "suit-record") return `<span class="suit-record" aria-label="已点亮 ${node.suits.length}/4 种花色">${SUITS.map((suit) => `<span class="suit-record-cell ${suitPresentation(suit).red ? "red" : "black"}${node.suits.includes(suit) ? " is-recorded" : ""}" aria-label="${suitPresentation(suit).label}：${node.suits.includes(suit) ? "已点亮" : "未点亮"}">${suitMarkup(suit)}<span class="suit-record-mark" aria-hidden="true">${node.suits.includes(suit) ? "&#10003;" : "&middot;"}</span></span>`).join("")}</span>`;
    if (node.type === "rank-record") return `<span class="rank-record" aria-label="已记录 ${node.ranks.length}/13 个点数">${RANKS.map((rank) => `<span class="rank-record-cell${node.ranks.includes(rank) ? " is-recorded" : ""}${node.selected === rank ? " is-selected" : ""}" aria-label="${rank}：${node.ranks.includes(rank) ? "已记录" : "未记录"}${node.selected === rank ? "，本回合选中" : ""}"><span>${rank}</span><span class="rank-record-mark" aria-hidden="true">${node.ranks.includes(rank) ? "&#10003;" : "&middot;"}</span></span>`).join("")}</span>`;
    const text = escape(displayNodeText(node));
    if (node.type === "text") return `<span class="display-text">${text}</span>`;
    if (node.type === "number") return `<strong class="display-number">${text}</strong>`;
    const suit = node.type === "suit" ? node.value : node.suit;
    const color = suit && suitPresentation(suit).red ? "red" : "black";
    const face = suit === null || (node.type === "card" && node.rank === null) ? text
      : node.type === "suit" ? suitMarkup(suit)
      : `<span class="display-card-rank">${escape(String(node.rank))}</span>${suitMarkup(suit)}`;
    return `<span class="display-${node.type} ${color}${node.type === "card" ? ` ${node.format}` : ""}">${face}</span>`;
  }).join("");
}
export function displayChipsMarkup(displays: readonly ResolvedDisplay[], target: AbilityActor): string {
  const entries = displays.filter((display) => display.target === target);
  if (!entries.length) return "";
  const owner = target === "player" ? "玩家" : "对手";
  return `<div class="status-chips" data-display-actor="${target}" aria-label="${owner}持续信息">${entries.map((display) => {
    const first = display.content[0];
    const label = first?.type === "text" ? `<span class="display-label">${escape(first.text)}</span>` : "";
    const values = first?.type === "text" ? display.content.slice(1) : display.content;
    const showOwner = displays.some((entry) => entry.target !== target);
    const boardClass = display.content.some((node) => node.type === "rank-record") ? " status-chip-rank-record" : display.content.some((node) => node.type === "suit-record") ? " status-chip-suit-record" : "";
    return `<section class="status-chip${boardClass}${display.density === "compact" ? " status-chip-compact" : ""}" aria-label="${owner}${escape(displayText(display))}"><span class="display-heading"${showOwner ? ` data-owner-label="${owner}"` : ""}>${label}</span><output class="display-value">${displayContentMarkup({ ...display, content: values })}</output><button type="button" class="display-info-button" data-display-key="${escape(display.key)}" aria-label="查看${owner}${escape(displayText(display))}说明">i</button></section>`;
  }).join("")}</div>`;
}
/** Readings stay expanded; the containing dashboard limits scrolling to the stage. */
export function displayPanelMarkup(displays: readonly ResolvedDisplay[]): string {
  if (!displays.length) return "";
  const ordered = [...displays.filter((entry) => entry.target === "opponent"), ...displays.filter((entry) => entry.target === "player")];
  return `<section class="display-panel" aria-label="持续信息"><div id="display-dashboard-list" class="display-scroll" tabindex="0" role="region" aria-label="持续信息列表">${displayChipsMarkup(ordered, "opponent")}${displayChipsMarkup(ordered, "player")}</div></section>`;
}
