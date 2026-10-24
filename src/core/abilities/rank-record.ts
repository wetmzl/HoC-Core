import { cardRank } from "../blackjack/card";
import { RANKS, type Card, type Rank } from "../blackjack/types";

type Parameters = Readonly<Record<string, string | number | boolean>>;

/** Rank sets and entity ledgers share status lifecycle, independently of scoring rules. */
export function hasRecordedRank(parameters: Parameters | undefined, rank: Rank): boolean {
  return parameters?.[`rank:${rank}`] === true;
}
export function recordedRanks(parameters: Parameters | undefined): readonly Rank[] {
  return RANKS.filter((rank) => hasRecordedRank(parameters, rank));
}
export function recordRank(parameters: Parameters | undefined, rank: Rank): Parameters {
  return { ...parameters, [`rank:${rank}`]: true, selectedRank: rank };
}
export function recordCardAcquisitions(parameters: Parameters | undefined, cards: readonly Card[], record: Parameters | undefined): Parameters {
  const ledger: Record<string, string | number | boolean> = { ...parameters };
  for (const card of cards) {
    const key = `card:${card.id}`;
    if (ledger[key] === true) continue;
    ledger[key] = true;
    if (hasRecordedRank(record, cardRank(card))) ledger.count = (typeof ledger.count === "number" ? ledger.count : 0) + 1;
  }
  return ledger;
}
