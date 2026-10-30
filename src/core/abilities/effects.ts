import { handValueAtLimit } from "../blackjack/hand";
import { resolveValue, selectedHandCard } from "./value-expressions";
import { recordCardAcquisitions, recordRank } from "./rank-record";
import { addAbilityInstance } from "./runtime";
import type { SeededRng } from "../rng/seeded";
import { addGunBullets, removeGunBullets, addToPendingLoad, multiplyPendingLoad, setPendingLoad } from "./roulette-adapter";
import { drawPhysicalCandidate, redealInitialHand, drawExactResultingTotal, handTotal, moveHandCardToDrawPile, replaceLastHandCard, transformHandCard, swapLastHandCardWithDrawPileTop } from "./card-zone-adapter";
import { addCardTag, cardRank, cardSuit, createCard, createDerivedCard, createDerivedCardId, isDerivedCard, removeCardTag } from "../blackjack/card";
import { RANKS, SUITS, type Card, type Rank, type Suit } from "../blackjack/types";
import { getAbilityDefinition, getStatusDefinition, instantiateAbility, type AbilityRegistry } from "./registry";
import { resolveActor, resolveScalar, safeLastHitTransfer, type ConditionContext } from "./conditions";
import { PLAYER_SKILL_INVENTORY_CAPACITY } from "../skills/constants";
import { recordPlayerSkillAcquisition } from "../skills/acquisition";
import { selectSkillCards, skillCardAgreesWithInstance } from "./skill-card-selection";
import type { AbilityDomainEvent, AbilityEffectResult, AbilityRuntimeState, AbilityWorld, DerivedCardRankExpression, DerivedCardSuitExpression, Effect, PendingAiThreshold, PendingComparison, PendingDefeat, PendingDraw, PendingLoad, PendingTrigger, PendingTurn } from "./types";

export interface EffectContext extends ConditionContext {
  readonly ruleId?: string;
  readonly rng: SeededRng;
  readonly runtime: AbilityRuntimeState;
  readonly forecastHitBust?: (owner: "player" | "opponent", world: AbilityWorld) => boolean;
  readonly registry?: AbilityRegistry;
}

function withHands(world: AbilityWorld, actor: "player" | "opponent", hand: AbilityWorld["hands"]["player"]): AbilityWorld { return { ...world, hands: { ...world.hands, [actor]: hand } }; }
function statusFor(world: AbilityWorld, actor: "player" | "opponent", id: string) { return world.statuses.find((status) => status.owner === actor && status.statusDefinitionId === id); }

function resolveDerivedRank(expression: DerivedCardRankExpression, actor: "player" | "opponent", context: EffectContext): Rank {
  let rank: string | undefined;
  if (expression.type === "value") {
    const value = resolveValue(expression.value, context);
    if (typeof value !== "string") throw new Error("Card rank value must be text");
    rank = value;
  } else if (expression.type === "static") rank = expression.rank;
  else if (expression.type === "scalar") {
    const value = resolveScalar(expression.value, context);
    if (!Number.isInteger(value) || value < 1 || value > 13) throw new Error(`Scalar card rank is invalid: ${value}`);
    rank = value === 1 ? "A" : value === 11 ? "J" : value === 12 ? "Q" : value === 13 ? "K" : String(value);
  } else {
    const card = expression.card === "last-card" ? context.world.hands[actor].cards.at(-1) : context.world.hands[actor].cards[expression.card === "first-public-card" ? 0 : 1];
    if (!card) throw new Error("Card rank source is unavailable");
    rank = expression.map[cardRank(card)];
  }
  if (!rank || !RANKS.includes(rank as Rank)) throw new Error(`Derived card rank is invalid: ${rank ?? "undefined"}`);
  return rank as Rank;
}

function resolveDerivedSuit(expression: DerivedCardSuitExpression, actor: "player" | "opponent", context: EffectContext): Suit {
  if (expression.type === "value") {
    const value = resolveValue(expression.value, context);
    if (typeof value !== "string" || !SUITS.includes(value as Suit)) throw new Error("Card suit value is invalid");
    return value as Suit;
  }
  if (expression.type === "static") return expression.suit;
  if (expression.type === "uniform-ability-rng") return SUITS[context.rng.nextInt(SUITS.length)]!;
  const card = expression.card === "last-card" ? context.world.hands[actor].cards.at(-1) : context.world.hands[actor].cards[expression.card === "first-public-card" ? 0 : 1];
  if (!card) throw new Error("Card suit source is unavailable");
  return cardSuit(card);
}

function resultEvent(context: EffectContext, result: Extract<AbilityDomainEvent, { type: "ABILITY_RESULT" }>['result']): AbilityDomainEvent {
  return { type: "ABILITY_RESULT", ...((context.ability.level ?? 1) > 1 ? { level: context.ability.level } : {}), instanceId: context.ability.instanceId, definitionId: context.ability.definitionId, owner: context.ability.owner, result };
}

export function applyEffect(effect: Effect, context: EffectContext, pending: { turn?: PendingTurn; aiThreshold?: PendingAiThreshold; draw?: PendingDraw; load?: PendingLoad; bust?: import("./types").PendingBustCheck; trigger?: PendingTrigger; comparison?: PendingComparison; defeat?: PendingDefeat } = {}): AbilityEffectResult {
  const gainedAbilities: import("./types").AbilityInstance[] = [];
  let world = context.world;
  let turn = pending.turn;
  let aiThreshold = pending.aiThreshold;
  let draw = pending.draw;
  let load = pending.load;
  let bust = pending.bust;
  let trigger = pending.trigger;
  let comparison = pending.comparison;
  let defeat = pending.defeat;
  let runtime = context.runtime;
  const events: AbilityDomainEvent[] = [];
  // Most effects are actor-relative. The draw-pile rotation primitive is
  // intentionally match-global and has no target selector.
  const actor = "target" in effect ? resolveActor(effect.target, context) : "player";
  if (!actor) throw new Error(`Cannot resolve actor selector: ${(effect as { readonly target?: unknown }).target ?? "unknown"}`);
  const changed = (effectType: string): void => { events.push({ type: "PENDING_EVENT_MODIFIED", eventId: turn?.id ?? aiThreshold?.id ?? draw?.id ?? load?.id ?? bust?.id ?? trigger?.id ?? defeat?.id ?? context.event.sourceEventId, effectType, sourceInstanceId: context.ability.instanceId }); };
  switch (effect.type) {
    case "assign-status-values": {
      const definition = getStatusDefinition(effect.statusDefinitionId, context.registry);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      const values = Object.fromEntries(Object.entries(effect.values).map(([key, expression]) => [key, resolveValue(expression, context)]));
      const stacks = effect.stacks === undefined ? existing?.stacks ?? 1 : resolveScalar(effect.stacks, context);
      if (!Number.isSafeInteger(stacks) || stacks < 1) throw new Error("Assigned status stacks must be positive");
      const status = { statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: existing?.sourceInstanceId ?? context.ability.instanceId,
        stacks, duration: existing?.duration ?? definition.defaultDuration, parameters: { ...(effect.mode === "replace" ? {} : existing?.parameters), ...values }, createdAtSequence: existing?.createdAtSequence ?? runtime.sequence + 1 };
      world = { ...world, statuses: [...world.statuses.filter(entry => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: existing ? runtime.sequence : runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: status.sourceInstanceId });
      break;
    }
    case "transform-hand-card": {
      const card = selectedHandCard(effect.target, effect.card, context);
      const hand = world.hands[actor];
      const result = card && transformHandCard(hand, hand.cards.findIndex(entry => entry.id === card.id), effect.output.count, resolveScalar(effect.output.total, context), effect.output.suits, context.rng, context.ability.definitionId);
      if (!result) throw new Error("Card transformation has no valid output");
      world = withHands(world, actor, result.hand);
      break;
    }
    case "acquire-card": {
      const hand = world.hands[actor];
      let card: Card | undefined;
      for (const choice of effect.choices) {
        if (choice.source === "derived" && "rank" in choice) {
          const rank = resolveDerivedRank(choice.rank, actor, context);
          const suit = resolveDerivedSuit(choice.suit, actor, context);
          card = createDerivedCard(suit, rank, createDerivedCardId(context.rng), context.ability.definitionId);
        } else {
          const total = choice.candidate ? resolveScalar(choice.candidate.value, context) : undefined;
          const limit = choice.evaluationLimit !== undefined ? resolveScalar(choice.evaluationLimit, context) : 21;
          const matches = (candidate: Card): boolean => total === undefined || (choice.candidate?.type === "resulting-hand-total-at-most"
            ? handValueAtLimit({ cards: [...hand.cards, candidate] }, limit) <= total : handValueAtLimit({ cards: [...hand.cards, candidate] }, limit) === total);
          if (choice.source === "draw-pile") {
            const selected = drawPhysicalCandidate(world.shoe, hand, choice.candidate ? { operator: choice.candidate.type === "resulting-hand-total-at-most" ? "at-most" : "exactly", value: total!, evaluationLimit: limit } : undefined, choice.pick, context.rng);
            if (!selected) continue;
            card = selected.card;
            world = { ...world, shoe: selected.shoe };
          } else {
            const ranks = RANKS.filter(rank => matches(createCard("spades", rank)));
            if (!ranks.length) continue;
            const suit = SUITS[context.rng.nextInt(SUITS.length)]!;
            const rank = choice.pick === "uniform-ability-rng" ? ranks[context.rng.nextInt(ranks.length)]! : ranks[0]!;
            card = createDerivedCard(suit, rank, createDerivedCardId(context.rng), context.ability.definitionId);
          }
        }
        if (card) break;
      }
      if (!card) throw new Error("No acquisition choice can supply a card");
      world = withHands(world, actor, { cards: [...hand.cards, card] });
      if (effect.reveal) events.push({ type: "CARD_DEALT", actor, card, private: false });
      if (effect.reportResult && isDerivedCard(card)) events.push(resultEvent(context, { type: "derived-card-added", actor, rank: cardRank(card), suit: cardSuit(card) }));
      break;
    }
    case "remove-skill-cards": {
      const cards = selectSkillCards(world, actor, effect.filter, context.registry);
      const ids = new Set(cards.map(card => card.instanceId));
      for (const card of cards) {
        const instance = runtime.instances.find(entry => entry.instanceId === card.instanceId);
        if (!skillCardAgreesWithInstance(card, instance)) throw new Error("Skill card and runtime instance disagree");
      }
      const expired = runtime.statuses.filter(status => ids.has(status.sourceInstanceId));
      const knownIds = runtime.instances.map(instance => instance.instanceId).sort((a, b) => b.length - a.length);
      runtime = { ...runtime,
        instances: runtime.instances.filter(instance => !ids.has(instance.instanceId)),
        statuses: runtime.statuses.filter(status => !ids.has(status.sourceInstanceId)),
        counters: Object.fromEntries(Object.entries(runtime.counters).filter(([key]) => !ids.has(knownIds.find(id => key.startsWith(`${id}:`)) ?? "")))
      };
      world = { ...world, cards: world.cards.filter(card => !ids.has(card.instanceId)), statuses: runtime.statuses };
      if (cards.length) events.push({ type: "SKILL_CARDS_REMOVED", actor, sourceInstanceId: context.ability.instanceId, cards });
      events.push(...expired.map(status => ({ type: "STATUS_REMOVED" as const, statusDefinitionId: status.statusDefinitionId, owner: status.owner, reason: "dispelled" as const })));
      break;
    }
    case "transfer-hand-card": {
      const source = resolveActor(effect.from, context);
      if (!source || source === actor) throw new Error("Card transfer requires two distinct hands");
      const hand = world.hands[source];
      const card = effect.card === "last-hit-card" ? hand.cards.find(entry => entry.id === context.event.lastHitCardIds?.[source])
        : effect.card === "last-card" ? hand.cards.at(-1) : hand.cards[effect.card === "first-public-card" ? 0 : 1];
      if (!card || world.hands[actor].cards.some(entry => entry.id === card.id)) throw new Error("Transfer card is unavailable or duplicated");
      // Standalone callers may omit explicit knowledge for the implicit first
      // public card. Preserve that fact after it leaves the first hand slot.
      if (hand.cards[0]?.id === card.id && !world.publicCardIds?.includes(card.id)) events.push({ type: "CARD_REVEALED", target: actor, cardId: card.id });
      world = { ...world, hands: { ...world.hands, [source]: { cards: hand.cards.filter(entry => entry.id !== card.id) }, [actor]: { cards: [...world.hands[actor].cards, card] } } };
      break;
    }
    case "reveal-hand-cards-matching-public-suits": {
      const source = resolveActor(effect.suitsFrom, context);
      if (!source) throw new Error("Public suit source is unavailable");
      const publicIds = new Set(world.publicCardIds ?? []);
      for (const hand of Object.values(world.hands)) if (hand.cards[0]) publicIds.add(hand.cards[0].id);
      const suits = new Set(world.hands[source].cards.filter(card => publicIds.has(card.id)).map(cardSuit));
      for (const card of world.hands[actor].cards) {
        if (publicIds.has(card.id) || !suits.has(cardSuit(card))) continue;
        publicIds.add(card.id);
        events.push({ type: "CARD_REVEALED", target: actor, cardId: card.id });
      }
      world = { ...world, publicCardIds: [...publicIds] };
      break;
    }

    case "prevent-pending-defeat": {
      if (context.event.trigger !== "before-defeat" || !defeat) throw new Error("Defeat prevention requires the before-defeat window");
      if (defeat.actor !== actor) throw new Error("Pending defeat actor does not match effect target");
      if (defeat.prevented) throw new Error("Pending defeat is already prevented");
      defeat = { ...defeat, prevented: true, preventSourceInstanceId: context.ability.instanceId };
      changed(effect.type);
      break;
    }
    case "force-stand": {
      if (bust && bust.actor === actor && (context.event.trigger === "before-bust-check" || context.event.trigger === "before-bust-resolution")) {
        bust = { ...bust, standAfterReplacement: true };
      } else if (context.event.trigger === "on-ability-played" || context.event.trigger === "after-stand") {
        if (context.event.trigger === "after-stand" && world.stood?.[actor]) break;
        if (!world.stood || world.stood[actor]) throw new Error("Immediate force-stand requires an actor who has not stood");
        world = { ...world, stood: { ...world.stood, [actor]: true } };
      } else {
        if (context.event.trigger !== "after-hit-resolved" || !draw || draw.actor !== actor) throw new Error("force-stand requires a surviving actual Hit, an active ability, or a Stand event");
        draw = { ...draw, standAfterDraw: true };
      }
      changed(effect.type);
      break;
    }
    case "record-random-rank":
    case "record-hand-card-rank":
    case "count-new-matching-cards": {
      const definition = getStatusDefinition(effect.statusDefinitionId, context.registry);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      let parameters = existing?.parameters ?? {};
      let stacks = existing?.stacks ?? 1;
      if (effect.type === "count-new-matching-cards") {
        const recordActor = resolveActor(effect.recordTarget, context);
        const records = recordActor ? statusFor(world, recordActor, effect.recordStatusDefinitionId)?.parameters : undefined;
        parameters = recordCardAcquisitions(parameters, context.event.acquiredCards ?? world.hands[actor].cards, records);
      } else {
        const handActor = effect.type === "record-hand-card-rank" ? resolveActor(effect.handTarget, context) : undefined;
        const hand = handActor ? world.hands[handActor] : undefined;
        const card = effect.type === "record-hand-card-rank" ? effect.card === "last-card" ? hand?.cards.at(-1) : hand?.cards[effect.card === "first-public-card" ? 0 : 1] : undefined;
        if (effect.type === "record-hand-card-rank" && !card) throw new Error("Rank record card is unavailable");
        const rank = effect.type === "record-random-rank" ? RANKS[context.rng.nextInt(RANKS.length)]! : cardRank(card!);
        parameters = recordRank(parameters, rank);
        stacks = 1;
      }
      // The ledger remains live even when no acquired cards have matched.
      const status = { statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: existing?.sourceInstanceId ?? context.ability.instanceId, stacks, duration: definition.defaultDuration, parameters, createdAtSequence: existing?.createdAtSequence ?? runtime.sequence + 1 };
      world = { ...world, statuses: [...world.statuses.filter((entry) => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: existing ? runtime.sequence : runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: status.sourceInstanceId });
      break;
    }
    case "set-pending-ai-action": {
      if (context.event.trigger !== "before-ai-decision" || !aiThreshold || aiThreshold.actor !== actor) throw new Error("AI action override requires the target's AI decision window");
      aiThreshold = { ...aiThreshold, actionOverride: { action: effect.action, sourceInstanceId: context.ability.instanceId } };
      changed(effect.type);
      break;
    }
    case "redeal-initial-hand": {
      const dealt = redealInitialHand(world.shoe);
      if (!dealt) throw new Error("Initial hand redeal requires two remaining physical cards");
      events.push({ type: "HAND_REDEALT", actor, discardedCardIds: world.hands[actor].cards.map(card => card.id) });
      world = { ...withHands(world, actor, dealt.hand), shoe: dealt.shoe };
      dealt.hand.cards.forEach((card, index) => events.push({ type: "CARD_DEALT", actor, card, private: index !== 0 }));
      break;
    }
    case "skip-turn": {
      if (!turn) throw new Error("skip-turn outside turn-start event");
      if (turn.actor !== actor) throw new Error("Pending turn actor does not match effect target");
      if (!turn.canSkip) throw new Error("Pending turn has no available alternate actor");
      if (!turn.skipped) {
        turn = { ...turn, skipped: true, skipSourceInstanceId: context.ability.instanceId };
        changed(effect.type);
      }
      break;
    }
    case "add-to-pending-ai-threshold": {
      if (!aiThreshold) throw new Error("add-to-pending-ai-threshold outside AI decision event");
      if (aiThreshold.actor !== actor) throw new Error("Pending AI threshold actor does not match effect target");
      aiThreshold = { ...aiThreshold, bySkill: aiThreshold.bySkill + resolveScalar(effect.amount, context) };
      if (!Number.isFinite(aiThreshold.bySkill)) throw new Error("Pending AI skill threshold modifier must be finite");
      changed(effect.type);
      break;
    }
    case "add-opening-skill-cards":
    case "add-skill-draw-refreshes": {
      if (actor !== "player") throw new Error("Only the player has a skill inventory");
      const amount = Math.max(0, Math.floor(resolveScalar(effect.amount, context)));
      if (!Number.isSafeInteger(amount)) throw new Error("Skill economy amount must be finite");
      if (effect.type === "add-opening-skill-cards") world = { ...world, openingSkillCardCount: Math.min(PLAYER_SKILL_INVENTORY_CAPACITY, (world.openingSkillCardCount ?? 3) + amount) };
      else {
        const total = (world.skillDrawRefreshes ?? 0) + amount;
        if (!Number.isSafeInteger(total)) throw new Error("Skill refresh count overflow");
        world = { ...world, skillDrawRefreshes: total };
      }
      break;
    }
    case "add-skill-draws": {
      if (actor !== "player") throw new Error("Only the player can receive skill draws");
      const amount = Math.max(0, Math.floor(resolveScalar(effect.amount, context)));
      world = { ...world, skillDraws: world.skillDraws + amount };
      break;
    }
    case "reveal-draw-pile-top-suit": {
      const viewer = resolveActor(effect.viewer, context);
      const card = world.shoe.cards[world.shoe.cursor];
      if (!viewer || !card) throw new Error("Draw-pile top card is unavailable");
      events.push({ type: "DRAW_PILE_CARD_SUIT_REVEALED", viewer, cardId: card.id, suit: cardSuit(card) });
      break;
    }
    case "publish-hit-bust-forecast":
      if (!context.forecastHitBust) throw new Error("No Hit bust forecaster configured");
      events.push(resultEvent(context, { type: "hit-bust-forecast", actor, wouldBust: context.forecastHitBust(actor, world) }));
      break;
    case "publish-hand-total-comparison": {
      const rival = actor === "player" ? "opponent" : "player";
      const ownerTotal = handTotal(world.hands[actor]);
      const rivalTotal = handTotal(world.hands[rival]);
      events.push(resultEvent(context, { type: "hand-total-compared", actor, relation: ownerTotal === rivalTotal ? "equal" : ownerTotal > rivalTotal ? "higher" : "lower" }));
      break;
    }
    case "replace-hand-card": {
      const hand = world.hands[actor];
      const candidate = effect.candidate.type === "resulting-hand-total-at-most" ? "at-most" : "exactly";
      const result = replaceLastHandCard(world.shoe, hand, context.rng, candidate, resolveScalar(effect.candidate.value, context));
      if (!result) throw new Error("No legal card candidate");
      world = withHands({ ...world, shoe: result.shoe }, actor, result.hand);
      changed(effect.type);
      break;
    }
    case "discard-hand-card": {
      const hand = world.hands[actor];
      const index = effect.card === "last-card" ? hand.cards.length - 1 : effect.card === "first-public-card" ? 0 : 1;
      const card = hand.cards[index];
      if (!card) throw new Error("Selected hand card is unavailable");
      // Physical cards remain consumed in the shoe ledger; derived cards dissipate.
      world = withHands(world, actor, { cards: hand.cards.filter((_, i) => i !== index) });
      events.push({ type: "HAND_CARD_DISCARDED", actor, cardId: card.id });
      break;
    }
    case "move-hand-card-to-draw-pile": {
      const hand = world.hands[actor];
      const cardIndex = effect.card === "last-card" ? hand.cards.length - 1 : effect.card === "first-public-card" ? 0 : 1;
      const result = moveHandCardToDrawPile(world.shoe, hand, cardIndex, effect.position);
      if (!result) throw new Error("Selected physical hand card cannot return to the draw pile");
      world = withHands({ ...world, shoe: result.shoe }, actor, result.hand);
      changed(effect.type);
      break;
    }
    case "swap-last-hand-card-with-draw-pile-top": {
      const outgoing = world.hands[actor].cards.at(-1);
      const result = swapLastHandCardWithDrawPileTop(world.shoe, world.hands[actor]);
      if (!result) throw new Error("Cannot swap an empty hand or draw pile");
      world = withHands({ ...world, shoe: result.shoe }, actor, result.hand);
      if (outgoing && !isDerivedCard(outgoing)) {
        events.push({ type: "DRAW_PILE_CARD_REVEALED", viewer: actor, cardId: outgoing.id, rank: cardRank(outgoing), suit: cardSuit(outgoing) });
      }
      changed(effect.type);
      break;
    }
    case "transfer-last-hit-card-instead-of-draw": {
      if (context.event.trigger !== "before-card-draw" || !draw || draw.actor !== actor || draw.cancelled) throw new Error("Card transfer requires an uncancelled draw for its target");
      const transferred = safeLastHitTransfer(effect.from, effect.target, { ...context, event: { ...context.event, pendingDraw: draw } });
      if (!transferred) throw new Error("Last Hit card cannot be transferred safely");
      world = transferred;
      draw = { ...draw, cancelled: true };
      events.push({ type: "PENDING_EVENT_CANCELLED", eventId: draw.id, sourceInstanceId: context.ability.instanceId });
      break;
    }
    case "reveal-hand-card-suit": {
      const targetHand = world.hands[actor];
      const viewer = resolveActor(effect.viewer, context);
      const cards = effect.card === "all-current-cards" ? targetHand.cards : targetHand.cards.slice(1, 2);
      if (!viewer || cards.length === 0) throw new Error(effect.card === "all-current-cards" ? "Hand is unavailable" : "Private card is unavailable");
      for (const card of cards) {
        events.push({ type: "CARD_SUIT_REVEALED", viewer, target: actor, cardId: card.id, suit: cardSuit(card) });
      }
      break;
    }
    case "add-status": {
      const definition = getStatusDefinition(effect.statusDefinitionId, context.registry);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      const status = { statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: context.ability.instanceId, stacks: (existing?.stacks ?? 0) + 1, duration: definition.defaultDuration, parameters: { ...(existing?.parameters ?? {}), ...(effect.parameters ?? {}) }, createdAtSequence: runtime.sequence + 1 };
      world = { ...world, statuses: [...world.statuses.filter((entry) => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: context.ability.instanceId });
      events.push(resultEvent(context, { type: "status-stacks-updated", actor, statusDefinitionId: effect.statusDefinitionId, stacks: status.stacks, delta: 1 }));
      break;
    }
    case "set-status-stacks": {
      const definition = getStatusDefinition(effect.statusDefinitionId, context.registry);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      const stacks = Math.max(0, Math.floor(resolveScalar(effect.amount, context)));
      if (stacks === 0) {
        if (existing) {
          world = { ...world, statuses: world.statuses.filter((entry) => entry !== existing) };
          runtime = { ...runtime, statuses: world.statuses };
          events.push({ type: "STATUS_REMOVED", statusDefinitionId: effect.statusDefinitionId, owner: actor, reason: "consumed" });
        }
        break;
      }
      const status = {
        statusDefinitionId: effect.statusDefinitionId,
        owner: actor,
        sourceInstanceId: context.ability.instanceId,
        stacks,
        duration: definition.defaultDuration,
        parameters: existing?.parameters ?? {},
        createdAtSequence: existing?.createdAtSequence ?? runtime.sequence + 1
      };
      world = { ...world, statuses: [...world.statuses.filter((entry) => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: existing ? runtime.sequence : runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: context.ability.instanceId });
      events.push(resultEvent(context, { type: "status-stacks-updated", actor, statusDefinitionId: effect.statusDefinitionId, stacks, delta: stacks - (existing?.stacks ?? 0) }));
      break;
    }
    case "remove-status": {
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      if (!existing) break;
      const amount = Math.max(1, Math.floor(effect.amount === undefined ? 1 : resolveScalar(effect.amount, context)));
      const stacks = existing.stacks - amount;
      world = { ...world, statuses: stacks > 0 ? world.statuses.map((entry) => entry === existing ? { ...entry, stacks } : entry) : world.statuses.filter((entry) => entry !== existing) };
      runtime = { ...runtime, statuses: world.statuses };
      if (stacks <= 0) events.push({ type: "STATUS_REMOVED", statusDefinitionId: effect.statusDefinitionId, owner: actor, reason: "consumed" });
      break;
    }
    case "replace-pending-draw": {
      if (!draw) throw new Error("replace-pending-draw outside draw event");
      if (draw.actor !== actor) throw new Error("Pending draw actor does not match effect target");
      const hand = world.hands[actor];
      const result = drawExactResultingTotal(world.shoe, hand, context.rng, resolveScalar(effect.policy.total, context), context.ability.definitionId);
      if (!result) {
        events.push({ type: "ABILITY_RESOLUTION_FAILED", instanceId: context.ability.instanceId, definitionId: context.ability.definitionId, ruleId: context.ruleId ?? "unknown-rule", reason: "No compatible card can produce the requested total" });
        break;
      }
      draw = { ...draw, replacement: result.card };
      world = { ...world, shoe: result.shoe };
      changed(effect.type);
      break;
    }
    case "replace-hand-card-with-derived": {
      const hand = world.hands[actor];
      const old = selectedHandCard(effect.target, effect.card, context);
      if (!old) throw new Error("Cannot replace a card in an empty hand");
      const rank = resolveDerivedRank(effect.rank, actor, context);
      const suit = resolveDerivedSuit(effect.suit, actor, context);
      world = withHands(world, actor, { cards: hand.cards.map(card => card.id === old.id ? createDerivedCard(suit, rank, createDerivedCardId(context.rng), context.ability.definitionId) : card) });
      if (effect.reportResult !== false) events.push(resultEvent(context, { type: "derived-card-replaced", actor, oldRank: cardRank(old), rank, suit }));
      break;
    }
    case "add-hand-card-tag":
    case "remove-hand-card-tag": {
      const hand = world.hands[actor];
      const index = effect.card === "last-card" ? hand.cards.length - 1 : effect.card === "first-public-card" ? 0 : 1;
      const card = hand.cards[index];
      if (!card) throw new Error("Card tag target is unavailable");
      const updated = effect.type === "add-hand-card-tag" ? addCardTag(card, effect.tag) : removeCardTag(card, effect.tag);
      if (updated !== card) world = withHands(world, actor, { cards: hand.cards.map((entry, cardIndex) => cardIndex === index ? updated : entry) });
      break;
    }
    case "rotate-draw-pile-top-to-bottom": {
      if (world.shoe.cursor >= world.shoe.cards.length) throw new Error("Cannot rotate an empty draw pile");
      const remaining = world.shoe.cards.slice(world.shoe.cursor);
      const rotated = remaining.length <= 1 ? remaining : [...remaining.slice(1), remaining[0]!];
      world = { ...world, shoe: { ...world.shoe, cards: [...world.shoe.cards.slice(0, world.shoe.cursor), ...rotated] } };
      events.push(resultEvent(context, { type: "draw-pile-rotated" }));
      break;
    }
    case "grant-skill-card": {
      if (actor !== "player") throw new Error("Only the player can receive a Player Skill card");
      if (world.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY) throw new Error("Player Skill inventory is full");
      const selection = effect.choices.map(choice => choice.type === "self" ? { id: context.ability.definitionId, level: context.ability.level ?? 1 }
        : choice.type === "definition" ? { id: choice.definitionId, level: choice.level ?? 1 }
        : context.runtime.lastPlayedPlayerSkillDefinitionId ? { id: context.runtime.lastPlayedPlayerSkillDefinitionId, level: context.runtime.lastPlayedPlayerSkillLevel ?? 1 } : undefined).find(Boolean);
      if (!selection) throw new Error("Skill definition selection is unavailable");
      const selectedId = selection.id;
      const level = selection.level;
      const selected = getAbilityDefinition(selectedId, context.registry, level);
      if (!selected || selected.sourceKind !== "player-skill") throw new Error(`Cannot grant a non-player skill definition: ${selectedId}`);
      if (selected.activation.type !== "action" && !selected.stackable && world.cards.some(card => card.definitionId === selected.id)) throw new Error("A non-stackable passive skill is already held");
      const skillAcquisitionCounts = recordPlayerSkillAcquisition(selected, world.skillAcquisitionCounts, world.cards.map(card => card.definitionId));
      const sequence = context.runtime.sequence + 1;
      const instanceId = `ability-player-card-${sequence}`;
      const instance = instantiateAbility({ definitionId: selected.id, level, enabled: true, parameters: {} }, "player", instanceId, sequence, context.registry, "player-skill");
      runtime = addAbilityInstance(runtime, instance, context.registry);
      if (effect.initialize !== false) gainedAbilities.push(instance);
      world = { ...world, skillAcquisitionCounts, cards: [...world.cards, { kind: "player-skill", definitionId: selected.id, level, owner: "player", instanceId }] };
      events.push(resultEvent(context, { type: "skill-card-granted", definitionId: selected.id }));
      events.push({ type: "SKILL_GAINED", skillId: selected.id });
      break;
    }
    case "add-to-pending-bust-limit": {
      if (!bust) throw new Error("add-to-pending-bust-limit outside bust check event");
      if (bust.actor !== actor) throw new Error("Pending bust actor does not match effect target");
      bust = { ...bust, limit: Math.max(effect.allowDecrease ? 1 : bust.limit, bust.limit + resolveScalar(effect.amount, context)) };
      changed(effect.type);
      break;
    }
    case "add-to-pending-trigger-misfire-chance": {
      if (!trigger) throw new Error("add-to-pending-trigger-misfire-chance outside trigger event");
      if (trigger.actor !== actor) throw new Error("Pending trigger actor does not match effect target");
      trigger = { ...trigger, misfireChance: Math.max(0, Math.min(1, (trigger.misfireChance ?? 0) + resolveScalar(effect.amount, context))) };
      changed(effect.type);
      break;
    }
    case "add-to-pending-load": {
      if (!load) throw new Error("add-to-pending-load outside load event");
      if (load.actor !== actor) throw new Error("Pending load actor does not match effect target");
      load = addToPendingLoad(load, resolveScalar(effect.amount, context));
      changed(effect.type);
      break;
    }
    case "set-pending-load": {
      if (!load) throw new Error("set-pending-load outside load event");
      if (load.actor !== actor) throw new Error("Pending load actor does not match effect target");
      load = setPendingLoad(load, resolveScalar(effect.amount, context));
      changed(effect.type);
      break;
    }
    case "multiply-pending-load": {
      if (!load) throw new Error("multiply-pending-load outside load event");
      if (load.actor !== actor) throw new Error("Pending load actor does not match effect target");
      load = multiplyPendingLoad(load, resolveScalar(effect.factor, context));
      changed(effect.type);
      break;
    }
    case "remove-gun-bullets":
    case "add-gun-bullets": {
      const oldGun = world.guns[actor];
      const adjust = effect.type === "add-gun-bullets" ? addGunBullets : removeGunBullets;
      const gun = adjust(oldGun, resolveScalar(effect.amount, context));
      world = { ...world, guns: { ...world.guns, [actor]: gun } };
      events.push(resultEvent(context, { type: "gun-bullets-added", actor, amount: gun.bullets - oldGun.bullets, bullets: gun.bullets }));
      break;
    }
    case "add-to-pending-comparison-score": {
      if (!comparison) throw new Error("add-to-pending-comparison-score outside comparison resolution");
      const score = comparison.scores[actor] + resolveScalar(effect.amount, context);
      if (!Number.isFinite(score)) throw new Error("Comparison score is not finite");
      comparison = { ...comparison, scores: { ...comparison.scores, [actor]: score } };
      changed(effect.type);
      break;
    }
    case "cancel-pending-trigger": {
      if (!trigger) throw new Error("cancel-pending-trigger outside trigger event");
      if (trigger.actor !== actor) throw new Error("Pending trigger actor does not match effect target");
      if (!trigger.cancelled) {
        trigger = { ...trigger, cancelled: true, cancelSourceInstanceId: context.ability.instanceId };
        events.push({ type: "PENDING_EVENT_CANCELLED", eventId: trigger.id, sourceInstanceId: context.ability.instanceId });
      }
      break;
    }
  }
  const newlyPublicIds = events.flatMap(event => event.type === "CARD_REVEALED" ? [event.cardId] : event.type === "CARD_DEALT" && !event.private ? [event.card.id] : []);
  if (newlyPublicIds.length) world = { ...world, publicCardIds: [...new Set([...(world.publicCardIds ?? []), ...newlyPublicIds])] };
  return { ...(gainedAbilities.length ? { gainedAbilities } : {}), world, pendingTurn: turn, pendingAiThreshold: aiThreshold, pendingDraw: draw, pendingLoad: load, pendingBust: bust, pendingTrigger: trigger, pendingComparison: comparison, pendingDefeat: defeat, runtime, events };
}

export function applyEffects(effects: readonly Effect[], context: EffectContext, pending: { turn?: PendingTurn; aiThreshold?: PendingAiThreshold; draw?: PendingDraw; load?: PendingLoad; bust?: import("./types").PendingBustCheck; trigger?: PendingTrigger; comparison?: PendingComparison; defeat?: PendingDefeat } = {}): AbilityEffectResult {
  const effectResults: Record<string, number> = Object.create(null);
  let result: AbilityEffectResult = { world: context.world, pendingTurn: pending.turn, pendingAiThreshold: pending.aiThreshold, pendingDraw: pending.draw, pendingLoad: pending.load, pendingBust: pending.bust, pendingTrigger: pending.trigger, pendingComparison: pending.comparison, pendingDefeat: pending.defeat, runtime: context.runtime, events: [] };
  for (const effect of effects) {
    const next = applyEffect(effect, { ...context, effectResults, event: { ...context.event, pendingComparison: result.pendingComparison }, world: result.world, runtime: result.runtime }, { turn: result.pendingTurn, aiThreshold: result.pendingAiThreshold, draw: result.pendingDraw, load: result.pendingLoad, bust: result.pendingBust, trigger: result.pendingTrigger, comparison: result.pendingComparison, defeat: result.pendingDefeat });
    if (effect.type === "remove-skill-cards" && effect.resultKey) {
      if (Object.hasOwn(effectResults, effect.resultKey)) throw new Error(`Duplicate effect result: ${effect.resultKey}`);
      effectResults[effect.resultKey] = result.world.cards.length - next.world.cards.length;
    }
    const gainedAbilities = [...(result.gainedAbilities ?? []), ...(next.gainedAbilities ?? [])];
    const acquiredCards = [...(result.acquiredCards ?? []), ...(["player", "opponent"] as const).flatMap((actor) => next.world.hands[actor].cards.filter((card) => !result.world.hands[actor].cards.some((old) => old.id === card.id)).map((card) => ({ actor, card })))];
    result = { ...(gainedAbilities.length ? { gainedAbilities } : {}), acquiredCards, world: next.world, pendingTurn: next.pendingTurn, pendingAiThreshold: next.pendingAiThreshold, pendingDraw: next.pendingDraw, pendingLoad: next.pendingLoad, pendingBust: next.pendingBust, pendingTrigger: next.pendingTrigger, pendingComparison: next.pendingComparison, pendingDefeat: next.pendingDefeat, runtime: next.runtime, events: [...result.events, ...next.events] };
  }
  const removedSources = new Set(context.runtime.instances.filter(instance => !result.runtime.instances.some(entry => entry.instanceId === instance.instanceId)).map(instance => instance.instanceId));
  if (result.world.statuses.some(status => removedSources.has(status.sourceInstanceId))) throw new Error("A removed ability cannot create new sourced statuses");
  return result;
}
