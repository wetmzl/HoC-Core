import { z } from "zod";
import { AbilityLevelNumberSchema } from "../abilities/schema";

/** One source for saved history validation and public event topic discovery. */
export function createGameEventSchema<Card extends z.ZodType, AbilityCard extends z.ZodType<{ instanceId: string; owner: string }>, RoundOutcome extends z.ZodType, AiDecision extends z.ZodType>(schemas: {
  card: Card; abilityCard: AbilityCard; roundOutcome: RoundOutcome; aiDecision: AiDecision;
}) {
  return z.union([
    z.object({ type: z.literal("SKILL_CARDS_REMOVED"), actor: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1), cards: z.array(schemas.abilityCard).min(1) }).strict().superRefine((event, ctx) => {
      if (new Set(event.cards.map(card => card.instanceId)).size !== event.cards.length || event.cards.some(card => card.owner !== event.actor)) ctx.addIssue({ code: "custom", message: "Removed skill cards must be distinct and match their owner" });
    }),
    z.object({ type: z.literal("ABILITY_PLAYED"), level: AbilityLevelNumberSchema.optional(), instanceId: z.string().min(1), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]) }).strict(),
    z.object({ type: z.literal("ABILITY_TRIGGERED"), level: AbilityLevelNumberSchema.optional(), instanceId: z.string().min(1), definitionId: z.string().min(1), ruleId: z.string().min(1), owner: z.enum(["player", "opponent"]) }).strict(),
    z.object({ type: z.literal("ABILITY_EXPIRED"), level: AbilityLevelNumberSchema.optional(), instanceId: z.string().min(1), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), reason: z.enum(["rounds", "triggers"]) }).strict(),
    z.object({ type: z.literal("ABILITY_RESOLUTION_FAILED"), instanceId: z.string().min(1), definitionId: z.string().min(1), ruleId: z.string().min(1), reason: z.string().min(1) }).strict(),
    z.object({ type: z.literal("STATUS_ADDED"), statusDefinitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("STATUS_REMOVED"), statusDefinitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), reason: z.enum(["consumed", "expired", "dispelled"]) }).strict(),
    z.object({ type: z.literal("PENDING_EVENT_MODIFIED"), eventId: z.string().min(1), effectType: z.string().min(1), sourceInstanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("PENDING_EVENT_CANCELLED"), eventId: z.string().min(1), sourceInstanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("CARD_REVEALED"), target: z.enum(["player", "opponent"]), cardId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("CARD_SUIT_REVEALED"), viewer: z.enum(["player", "opponent"]), target: z.enum(["player", "opponent"]), cardId: z.string().min(1), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
    z.object({ type: z.literal("DRAW_PILE_CARD_SUIT_REVEALED"), viewer: z.enum(["player", "opponent"]), cardId: z.string().min(1), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
    z.object({ type: z.literal("DRAW_PILE_CARD_REVEALED"), viewer: z.enum(["player", "opponent"]), cardId: z.string().min(1), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
    z.object({ type: z.literal("ABILITY_RESULT"), level: AbilityLevelNumberSchema.optional(), instanceId: z.string().min(1), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), result: z.union([
      z.object({ type: z.literal("derived-card-added"), actor: z.enum(["player", "opponent"]), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
      z.object({ type: z.literal("derived-card-replaced"), actor: z.enum(["player", "opponent"]), oldRank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
      z.object({ type: z.literal("status-stacks-updated"), actor: z.enum(["player", "opponent"]), statusDefinitionId: z.string().min(1), stacks: z.number().int().min(0), delta: z.number().int() }).strict(),
      z.object({ type: z.literal("skill-card-granted"), definitionId: z.string().min(1) }).strict(),
      z.object({ type: z.literal("draw-pile-rotated") }).strict(),
      z.object({ type: z.literal("hit-bust-forecast"), actor: z.enum(["player", "opponent"]), wouldBust: z.boolean() }).strict(),
      z.object({ type: z.literal("hand-total-compared"), actor: z.enum(["player", "opponent"]), relation: z.enum(["higher", "equal", "lower"]) }).strict(),
      z.object({ type: z.literal("gun-bullets-added"), actor: z.enum(["player", "opponent"]), amount: z.number().int(), bullets: z.number().int().min(0) }).strict()
    ]) }).strict(),
    z.object({ type: z.literal("ROUND_STARTED"), roundIndex: z.number().int().min(0) }).strict(),
    z.object({ type: z.literal("HAND_CARD_DISCARDED"), actor: z.enum(["player", "opponent"]), cardId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("HAND_REDEALT"), actor: z.enum(["player", "opponent"]), discardedCardIds: z.array(z.string().min(1)) }).strict(),
    z.object({ type: z.literal("CARD_DEALT"), actor: z.enum(["player", "opponent"]), card: schemas.card, private: z.boolean() }).strict(),
    z.object({ type: z.literal("INITIAL_BLACKJACK_CHECK"), player: z.boolean(), opponent: z.boolean() }).strict(),
    z.object({ type: z.literal("TURN_SKIPPED"), actor: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1) }).strict(),
    z.object({ type: z.enum(["PLAYER_HIT", "OPPONENT_HIT"]), value: z.number().int().min(0) }).strict(),
    z.object({ type: z.enum(["PLAYER_STOOD", "OPPONENT_STOOD"]) }).strict(),
    z.object({ type: z.literal("BLACKJACK"), actor: z.enum(["player", "opponent"]) }).strict(),
    z.object({ type: z.literal("BUST"), actor: z.enum(["player", "opponent"]) }).strict(),
    z.object({ type: z.literal("ROUND_RESOLVED"), outcome: schemas.roundOutcome }).strict(),
    z.object({ type: z.literal("ROUND_RESULT_ACKNOWLEDGED") }).strict(),
    z.object({ type: z.literal("BULLET_ADDED"), actor: z.enum(["player", "opponent"]), amount: z.number().int().min(0), actualAmount: z.number().int().min(0).optional() }).strict(),
    z.object({ type: z.literal("TRIGGER_PULLED"), bulletsBefore: z.number().int().nonnegative().optional(), capacityBefore: z.number().int().positive().optional(), actor: z.enum(["player", "opponent"]), probability: z.number().min(0).max(1), baseProbability: z.number().min(0).max(1), misfireChance: z.number().min(0).max(1), result: z.enum(["fired", "empty-chamber", "misfire"]), fired: z.boolean() }).strict().superRefine((event, ctx) => {
      if (event.fired !== (event.result === "fired")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fired"], message: "trigger result and fired flag disagree" });
    }),
    z.object({ type: z.literal("TRIGGER_SURVIVED"), actor: z.enum(["player", "opponent"]) }).strict(),
    z.object({ type: z.literal("DEFEAT_PREVENTED"), actor: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("TRIGGER_RESULT_ACKNOWLEDGED") }).strict(),
    z.object({ type: z.literal("PARTICIPANT_KILLED"), actor: z.enum(["player", "opponent"]) }).strict(),
    z.object({ type: z.literal("SKILL_GAINED"), skillId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("SKILL_DRAWS_ADDED"), reason: z.enum(["blackjack", "win", "loss", "push"]), amount: z.number().int().positive() }).strict(),
    z.object({ type: z.literal("SKILL_DRAW_OPENED"), offerId: z.string().min(1), candidateDefinitionIds: z.array(z.string().min(1)).min(1).max(3) }).strict(),
    z.object({ type: z.literal("SKILL_DRAW_REFRESHED"), offerId: z.string().min(1), candidateDefinitionIds: z.array(z.string().min(1)).min(1).max(3), refreshesRemaining: z.number().int().nonnegative().safe() }).strict(),
    z.object({ type: z.literal("SKILL_DRAW_RESOLVED"), offerId: z.string().min(1), selectedDefinitionId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("MATCH_FINISHED"), reason: z.enum(["player-killed", "opponent-killed", "escaped"]) }).strict(),
    z.object({ type: z.literal("MATCH_ESCAPED"), }).strict(),
    z.object({ type: z.literal("MATCH_RESULT_ACKNOWLEDGED"), }).strict(),
    z.object({ type: z.literal("AI_DECISION"), decision: schemas.aiDecision }).strict()
  ]);
}
