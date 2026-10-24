import { handValue } from "../blackjack/hand";
import { shoeRemaining } from "../blackjack/shoe";
import type { Card } from "../blackjack/types";
import type { MatchObservation, ObservedParticipant } from "./types";
import type { MatchState, ParticipantState } from "../match/types";

function observeParticipant(participant: ParticipantState, viewer: "player" | "opponent", owner: "player" | "opponent"): ObservedParticipant {
  const cards: readonly (Card | null)[] = participant.hand.cards.map((card, index) => {
    if (viewer === owner || index === 0) return card;
    return null;
  });
  const knownCards = cards.filter((card): card is Card => card !== null);
  return {
    cards,
    stood: participant.stood,
    busted: participant.busted,
    value: viewer === owner ? handValue(participant.hand) : knownCards.length > 0 ? handValue({ cards: knownCards }) : null
  };
}

/** The projection is the only supported input to AI; the shoe order is never exposed. */
export function buildObservation(state: MatchState, viewer: "player" | "opponent"): MatchObservation {
  return {
    viewer,
    roundIndex: state.roundIndex,
    phase: state.round.phase,
    currentActor: state.round.currentActor,
    player: observeParticipant(state.player, viewer, "player"),
    opponent: observeParticipant(state.opponent, viewer, "opponent"),
    shoeRemaining: shoeRemaining(state.shoe),
    roulette: {
      playerBullets: state.roulette.player.bullets,
      opponentBullets: state.roulette.opponent.bullets,
      capacity: state.roulette.player.capacity
    }
  };
}
