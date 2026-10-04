import { addAbilityInstance } from "./runtime";
import type { SeededRng } from "../rng/seeded";
import { addGunBullets, addToPendingLoad, multiplyPendingLoad, setPendingLoad } from "./roulette-adapter";
import { redealInitialHand, createDerivedCardForExactTotal, drawExactResultingTotal, handTotal, replaceLastHandCard, splitLastCardIntoDerived, swapLastHandCardWithDrawPileTop, transferLastPhysicalHandCard } from "./card-zone-adapter";
import { addCardTag, cardRank, cardSource, cardSuit, createDerivedCard, createDerivedCardId, isDerivedCard, removeCardTag } from "../blackjack/card";
import { RANKS, SUITS, type Rank, type Suit } from "../blackjack/types";
import { getAbilityDefinition, getStatusDefinition, instantiateAbility, type AbilityRegistry } from "./registry";
import { resolveActor, resolveScalar, type ConditionContext } from "./conditions";
import { PLAYER_SKILL_INVENTORY_CAPACITY } from "../skills/constants";
import type { AbilityDomainEvent, AbilityEffectResult, AbilityRuntimeState, AbilityWorld, DerivedCardRankExpression, DerivedCardSuitExpression, Effect, PendingAiThreshold, PendingComparison, PendingDraw, PendingLoad, PendingTrigger, PendingTurn } from "./types";

export interface EffectContext extends ConditionContext {
  readonly ruleId?: string;
  readonly rng: SeededRng;
  readonly runtime: AbilityRuntimeState;
  readonly publishAdvice?: (owner: "player" | "opponent", world: AbilityWorld) => "hit" | "stand";
  readonly forecastHitBust?: (owner: "player" | "opponent", world: AbilityWorld) => boolean;
  readonly registry?: AbilityRegistry;
}

function withHands(world: AbilityWorld, actor: "player" | "opponent", hand: AbilityWorld["hands"]["player"]): AbilityWorld { return { ...world, hands: { ...world.hands, [actor]: hand } }; }
function statusFor(world: AbilityWorld, actor: "player" | "opponent", id: string) { return world.statuses.find((status) => status.owner === actor && status.statusDefinitionId === id); }

function resolveDerivedRank(expression: DerivedCardRankExpression, actor: "player" | "opponent", context: EffectContext): Rank {
  let rank: string | undefined;
  if (expression.type === "static") rank = expression.rank;
  else if (expression.type === "scalar") {
    const value = resolveScalar(expression.value, context);
    if (!Number.isInteger(value) || value < 1 || value > 13) throw new Error(`Scalar card rank is invalid: ${value}`);
    rank = value === 1 ? "A" : value === 11 ? "J" : value === 12 ? "Q" : value === 13 ? "K" : String(value);
  } else {
    const card = expression.card === "last-card" ? context.world.hands[actor].cards.at(-1) : context.world.hands[actor].cards[1];
    if (!card) throw new Error("Card rank source is unavailable");
    rank = expression.map[cardRank(card)];
  }
  if (!rank || !RANKS.includes(rank as Rank)) throw new Error(`Derived card rank is invalid: ${rank ?? "undefined"}`);
  return rank as Rank;
}

function resolveDerivedSuit(expression: DerivedCardSuitExpression, context: EffectContext): Suit {
  return expression.type === "static" ? expression.suit : SUITS[context.rng.nextInt(SUITS.length)]!;
}

function resultEvent(context: EffectContext, result: Extract<AbilityDomainEvent, { type: "ABILITY_RESULT" }>['result']): AbilityDomainEvent {
  return { type: "ABILITY_RESULT", instanceId: context.ability.instanceId, definitionId: context.ability.definitionId, owner: context.ability.owner, result };
}

export function applyEffect(effect: Effect, context: EffectContext, pending: { turn?: PendingTurn; aiThreshold?: PendingAiThreshold; draw?: PendingDraw; load?: PendingLoad; bust?: import("./types").PendingBustCheck; trigger?: PendingTrigger; comparison?: PendingComparison } = {}): AbilityEffectResult {
  let world = context.world;
  let turn = pending.turn;
  let aiThreshold = pending.aiThreshold;
  let draw = pending.draw;
  let load = pending.load;
  let bust = pending.bust;
  let trigger = pending.trigger;
  let comparison = pending.comparison;
  let runtime = context.runtime;
  const events: AbilityDomainEvent[] = [];
  // Most effects are actor-relative. The draw-pile rotation primitive is
  // intentionally match-global and has no target selector.
  const actor = "target" in effect ? resolveActor(effect.target, context) : "player";
  if (!actor) throw new Error(`Cannot resolve actor selector: ${(effect as { readonly target?: unknown }).target ?? "unknown"}`);
  const changed = (effectType: string): void => { events.push({ type: "PENDING_EVENT_MODIFIED", eventId: turn?.id ?? aiThreshold?.id ?? draw?.id ?? load?.id ?? bust?.id ?? trigger?.id ?? context.event.sourceEventId, effectType, sourceInstanceId: context.ability.instanceId }); };
  switch (effect.type) {
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
    case "add-skill-draws": {
      if (actor !== "player") throw new Error("Only the player can receive skill draws");
      const amount = Math.max(0, Math.floor(resolveScalar(effect.amount, context)));
      world = { ...world, skillDraws: world.skillDraws + amount };
      break;
    }
    case "publish-action-advice":
      if (!context.publishAdvice) throw new Error("No action-advice publisher configured");
      world = { ...world, advice: context.publishAdvice(actor, world) };
      break;
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
    case "transfer-last-physical-hand-card": {
      const sourceActor = resolveActor(effect.from, context);
      if (!sourceActor || sourceActor === actor) throw new Error("Physical card transfer requires two distinct hands");
      const result = transferLastPhysicalHandCard(world.hands[sourceActor], world.hands[actor]);
      if (!result) throw new Error("Last physical hand card is unavailable");
      world = {
        ...world,
        hands: { ...world.hands, [sourceActor]: result.source, [actor]: result.target }
      };
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
    case "split-last-card-into-derived": {
      const result = splitLastCardIntoDerived(world.hands[actor], context.rng, context.ability.definitionId);
      if (!result) throw new Error("Last card cannot be split");
      world = withHands(world, actor, result.hand);
      break;
    }
    case "add-status": {
      const definition = context.registry?.statusesById[effect.statusDefinitionId] ?? getStatusDefinition(effect.statusDefinitionId);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      const status = { statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: context.ability.instanceId, stacks: (existing?.stacks ?? 0) + 1, duration: definition.defaultDuration, parameters: { ...(existing?.parameters ?? {}), ...(effect.parameters ?? {}) }, createdAtSequence: runtime.sequence + 1 };
      world = { ...world, statuses: [...world.statuses.filter((entry) => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: context.ability.instanceId });
      events.push(resultEvent(context, { type: "status-stacks-updated", actor, statusDefinitionId: effect.statusDefinitionId, stacks: status.stacks, delta: 1 }));
      break;
    }
    case "set-status-suit-to-hand-majority": {
      const handActor = resolveActor(effect.handTarget, context);
      if (!handActor) throw new Error("Majority-suit hand target is unavailable");
      const definition = context.registry?.statusesById[effect.statusDefinitionId] ?? getStatusDefinition(effect.statusDefinitionId);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const cards = world.hands[handActor].cards;
      if (cards.length === 0) throw new Error("Cannot select a majority suit from an empty hand");
      const counts = new Map(SUITS.map((suit) => [suit, cards.filter((card) => cardSuit(card) === suit).length]));
      const suit = SUITS.reduce((best, candidate) => counts.get(candidate)! > counts.get(best)! ? candidate : best);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      const status = {
        statusDefinitionId: effect.statusDefinitionId,
        owner: actor,
        sourceInstanceId: existing?.sourceInstanceId ?? context.ability.instanceId,
        stacks: 1,
        duration: definition.defaultDuration,
        parameters: { suit },
        createdAtSequence: existing?.createdAtSequence ?? runtime.sequence + 1
      } as const;
      world = { ...world, statuses: [...world.statuses.filter((entry) => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: existing ? runtime.sequence : runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: status.sourceInstanceId });
      break;
    }
    case "set-status-stacks": {
      const definition = context.registry?.statusesById[effect.statusDefinitionId] ?? getStatusDefinition(effect.statusDefinitionId);
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
    case "remember-last-card": {
      const cardActor = resolveActor(effect.cardTarget, context);
      const card = cardActor ? world.hands[cardActor].cards.at(-1) : undefined;
      if (!card) throw new Error("Cannot remember a card from an empty hand");
      const definition = context.registry?.statusesById[effect.statusDefinitionId] ?? getStatusDefinition(effect.statusDefinitionId);
      if (!definition) throw new Error(`Unknown status definition: ${effect.statusDefinitionId}`);
      const existing = statusFor(world, actor, effect.statusDefinitionId);
      const status = {
        statusDefinitionId: effect.statusDefinitionId,
        owner: actor,
        sourceInstanceId: existing?.sourceInstanceId ?? context.ability.instanceId,
        stacks: 1,
        duration: definition.defaultDuration,
        parameters: { rank: cardRank(card), suit: cardSuit(card), source: cardSource(card), cardId: card.id },
        createdAtSequence: existing?.createdAtSequence ?? runtime.sequence + 1
      } as const;
      world = { ...world, statuses: [...world.statuses.filter((entry) => entry !== existing), status] };
      runtime = { ...runtime, statuses: world.statuses, sequence: existing ? runtime.sequence : runtime.sequence + 1 };
      events.push({ type: "STATUS_ADDED", statusDefinitionId: effect.statusDefinitionId, owner: actor, sourceInstanceId: status.sourceInstanceId });
      break;
    }
    case "replace-bust-hand-card-with-memory-card": {
      if (!bust) throw new Error("replace-bust-hand-card-with-memory-card outside bust check event");
      if (bust.actor !== actor) throw new Error("Pending bust actor does not match effect target");
      const memory = world.statuses.find((entry) => entry.owner === actor && entry.statusDefinitionId === effect.statusDefinitionId && entry.stacks > 0);
      const rank = memory?.parameters.rank;
      const suit = memory?.parameters.suit;
      const hand = world.hands[actor];
      if (!memory || typeof rank !== "string" || typeof suit !== "string" || !RANKS.includes(rank as Rank) || !SUITS.includes(suit as Suit) || hand.cards.length === 0) throw new Error("Memory card is unavailable");
      const replacement = createDerivedCard(suit as Suit, rank as Rank, createDerivedCardId(context.rng), context.ability.definitionId);
      world = withHands(world, actor, { cards: [...hand.cards.slice(0, -1), replacement] });
      bust = { ...bust, standAfterReplacement: true };
      changed(effect.type);
      break;
    }
    case "add-derived-card-for-exact-total": {
      const hand = world.hands[actor];
      const card = createDerivedCardForExactTotal(hand, context.rng, resolveScalar(effect.total, context), context.ability.definitionId);
      if (!card) throw new Error("No derived card can produce the requested total");
      world = withHands(world, actor, { cards: [...hand.cards, card] });
      break;
    }
    case "add-derived-card": {
      const rank = resolveDerivedRank(effect.rank, actor, context);
      const suit = resolveDerivedSuit(effect.suit, context);
      const card = createDerivedCard(suit, rank, createDerivedCardId(context.rng), context.ability.definitionId);
      world = withHands(world, actor, { cards: [...world.hands[actor].cards, card] });
      events.push(resultEvent(context, { type: "derived-card-added", actor, rank, suit }));
      break;
    }
    case "copy-last-hand-card-as-derived": {
      const hand = world.hands[actor];
      const source = hand.cards.at(-1);
      if (!source) throw new Error("Card copy source is unavailable");
      const rank = cardRank(source);
      const suit = cardSuit(source);
      const card = createDerivedCard(suit, rank, createDerivedCardId(context.rng), context.ability.definitionId);
      world = withHands(world, actor, { cards: [...hand.cards, card] });
      events.push(resultEvent(context, { type: "derived-card-added", actor, rank, suit }));
      break;
    }
    case "replace-hand-card-with-derived": {
      const hand = world.hands[actor];
      const old = hand.cards.at(-1);
      if (!old) throw new Error("Cannot replace a card in an empty hand");
      const rank = resolveDerivedRank(effect.rank, actor, context);
      const suit = resolveDerivedSuit(effect.suit, context);
      world = withHands(world, actor, { cards: [...hand.cards.slice(0, -1), createDerivedCard(suit, rank, createDerivedCardId(context.rng), context.ability.definitionId)] });
      events.push(resultEvent(context, { type: "derived-card-replaced", actor, oldRank: cardRank(old), rank, suit }));
      break;
    }
    case "add-hand-card-tag":
    case "remove-hand-card-tag": {
      const hand = world.hands[actor];
      const index = effect.card === "last-card" ? hand.cards.length - 1 : 1;
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
    case "grant-player-skill-card": {
      if (actor !== "player") throw new Error("Only the player can receive a Player Skill card");
      if (world.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY) throw new Error("Player Skill inventory is full");
      const selectedId = context.runtime.lastPlayedPlayerSkillDefinitionId ?? context.ability.definitionId;
      const selected = context.registry?.definitionsById[selectedId] ?? getAbilityDefinition(selectedId);
      if (!selected || selected.sourceKind !== "player-skill" || selected.activation.type !== "action") throw new Error(`Cannot grant non-active Player Skill definition: ${selectedId}`);
      const sequence = context.runtime.sequence + 1;
      const instanceId = `ability-player-card-${sequence}`;
      const instance = instantiateAbility({ definitionId: selected.id, enabled: true, parameters: {} }, "player", instanceId, sequence, context.registry, "player-skill");
      runtime = addAbilityInstance(runtime, instance, context.registry);
      world = { ...world, cards: [...world.cards, { kind: "player-skill", definitionId: selected.id, owner: "player", instanceId }] };
      events.push(resultEvent(context, { type: "skill-card-granted", definitionId: selected.id }));
      events.push({ type: "SKILL_GAINED", skillId: selected.id });
      break;
    }
    case "add-to-pending-bust-limit": {
      if (!bust) throw new Error("add-to-pending-bust-limit outside bust check event");
      if (bust.actor !== actor) throw new Error("Pending bust actor does not match effect target");
      bust = { ...bust, limit: Math.max(bust.limit, bust.limit + resolveScalar(effect.amount, context)) };
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
    case "add-gun-bullets": {
      const oldGun = world.guns[actor];
      const gun = addGunBullets(oldGun, resolveScalar(effect.amount, context));
      world = { ...world, guns: { ...world.guns, [actor]: gun } };
      events.push(resultEvent(context, { type: "gun-bullets-added", actor, amount: gun.bullets - oldGun.bullets, bullets: gun.bullets }));
      break;
    }
    case "add-to-pending-comparison-score": {
      if (!comparison) throw new Error("add-to-pending-comparison-score outside comparison resolution");
      const score = resolveScalar(effect.amount, context);
      comparison = { ...comparison, scores: { ...comparison.scores, [actor]: comparison.scores[actor] + score } };
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
  return { world, pendingTurn: turn, pendingAiThreshold: aiThreshold, pendingDraw: draw, pendingLoad: load, pendingBust: bust, pendingTrigger: trigger, pendingComparison: comparison, runtime, events };
}

export function applyEffects(effects: readonly Effect[], context: EffectContext, pending: { turn?: PendingTurn; aiThreshold?: PendingAiThreshold; draw?: PendingDraw; load?: PendingLoad; bust?: import("./types").PendingBustCheck; trigger?: PendingTrigger; comparison?: PendingComparison } = {}): AbilityEffectResult {
  let result: AbilityEffectResult = { world: context.world, pendingTurn: pending.turn, pendingAiThreshold: pending.aiThreshold, pendingDraw: pending.draw, pendingLoad: pending.load, pendingBust: pending.bust, pendingTrigger: pending.trigger, pendingComparison: pending.comparison, runtime: context.runtime, events: [] };
  for (const effect of effects) {
    const next = applyEffect(effect, { ...context, world: result.world, runtime: result.runtime }, { turn: result.pendingTurn, aiThreshold: result.pendingAiThreshold, draw: result.pendingDraw, load: result.pendingLoad, bust: result.pendingBust, trigger: result.pendingTrigger, comparison: result.pendingComparison });
    result = { world: next.world, pendingTurn: next.pendingTurn, pendingAiThreshold: next.pendingAiThreshold, pendingDraw: next.pendingDraw, pendingLoad: next.pendingLoad, pendingBust: next.pendingBust, pendingTrigger: next.pendingTrigger, pendingComparison: next.pendingComparison, runtime: next.runtime, events: [...result.events, ...next.events] };
  }
  return result;
}
