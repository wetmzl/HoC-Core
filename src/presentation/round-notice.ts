import type { Actor, GameEvent, MatchState } from "../core/match/types";

function actorLabel(actor: Actor): string {
  return actor === "player" ? "你" : "对手";
}

/** Builds the persistent, decision-relevant summary shown before roulette. */
export function roundResultText(state: MatchState, penaltyCancelled = false): string {
  const outcome = state.round.outcome;
  if (!outcome) return "结果待揭晓";
  if (!outcome.winner || !outcome.penaltyTarget) return "平局·无惩罚";

  const winner = actorLabel(outcome.winner);
  const penalized = actorLabel(outcome.penaltyTarget);
  const penalty = penaltyCancelled ? "免罚" : "受罚";
  const load = outcome.reason === "bust"
    ? `装${outcome.bulletsAdded}发·${penalty}`
    : `${penalized}装${outcome.bulletsAdded}发·${penalty}`;

  if (outcome.reason === "bust") return `${penalized}爆牌·${load}`;
  if (outcome.reason === "blackjack") return `${winner}黑杰克·${load}`;
  return `${winner}胜利·${load}`;
}

export function triggerResultText(event: Extract<GameEvent, { type: "TRIGGER_PULLED" }>, defeatPrevented = false): string {
  if (event.result === "fired") return defeatPrevented ? `砰！${actorLabel(event.actor)}抵御了致命一击，对局继续。` : "砰！";
  if (event.result === "misfire") return "咔哒……哑火！";
  return "咔哒……空膛";
}
