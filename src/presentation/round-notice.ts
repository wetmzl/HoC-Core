import type { Actor, GameEvent, MatchState } from "../core/match/types";

function actorName(actor: Actor, opponentName: string): string {
  return actor === "player" ? "策展人" : opponentName;
}

/** Builds the persistent, decision-relevant summary shown before roulette. */
export function roundResultText(state: MatchState, opponentName: string, penaltyCancelled = false): string {
  const outcome = state.round.outcome;
  if (!outcome) return "本轮结果待揭晓。";
  if (!outcome.winner || !outcome.penaltyTarget) return "平局，即将进入下一轮。";

  const winner = actorName(outcome.winner, opponentName);
  const penalized = actorName(outcome.penaltyTarget, opponentName);
  const penalty = penaltyCancelled ? "免于左轮惩罚" : "接受左轮惩罚";
  const load = outcome.reason === "bust"
    ? `装填${outcome.bulletsAdded}发子弹，${penalty}。`
    : `${penalized}装填${outcome.bulletsAdded}发子弹，${penalty}。`;

  if (outcome.reason === "bust") return `${penalized}爆牌，${load}`;
  if (outcome.reason === "blackjack") return `${winner}黑杰克，${load}`;
  return `${winner}点数比较胜利，${load}`;
}

export function triggerResultText(event: Extract<GameEvent, { type: "TRIGGER_PULLED" }>): string {
  if (event.result === "fired") return "砰！";
  if (event.result === "misfire") return "咔哒……哑火！";
  return "咔哒……空膛";
}
