import type { PlayerSkillCarryover } from "../core/abilities/carryover";
import { AbilityLevelNumberSchema } from "../core/abilities/schema";
import { StoredChallengeRunSchema, type StoredChallengeRun } from "../core/challenge/schema";
import { StoredFlowRunSchema, type StoredFlowRun } from "../core/flow/schema";
import { ProgramRunSchema, type ProgramRun } from "../core/flow/program";
import { programMatchId } from "../core/flow/program-engine";
import { z } from "zod";
import { CharacterSkinPreferencesSchema } from "../content/packages/character-presentation";
import { CharacterSkinUnlocksSchema } from "./skin-unlocks";
import { CharacterDefeatProgressSchema } from "./character-defeats";
import { PluginSettingsDataSchema } from "../content/packages/plugin-declarations";
import packageInfo from "../../package.json" with { type: "json" };
import type { MatchHistoryRecord } from "../core/match/history";
import type { MatchState } from "../core/match/types";
import type { CharacterDefeatRecord } from "../core/progression/defeats";
import { getPlayerSkillDefinition } from "../core/skills/definitions";
import { PLAYER_SKILL_INVENTORY_CAPACITY } from "../core/skills/skills";
import { getTalentDefinition } from "../core/talents/definitions";
import { ABILITY_CATALOG_VERSION, getAbilityDefinition, getStatusDefinition, supportsAbilitySourceKind, validateAbilityBinding } from "../core/abilities/registry";
import { getCharacterMetadata } from "../content/characters/catalog";

export const LONG_TERM_SAVE_FORMAT = "house-of-chances-save" as const;
export const RUNTIME_SAVE_FORMAT = "house-of-chances-runtime" as const;
export const CURRENT_LONG_TERM_SCHEMA_VERSION = 9 as const;
export const CURRENT_RUNTIME_SCHEMA_VERSION = 15 as const;
export const CURRENT_GAME_VERSION = packageInfo.version;

const CardFaceSchema = {
  suit: z.enum(["spades", "hearts", "diamonds", "clubs"]),
  rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"])
};
const CardTagsSchema = z.array(z.string().min(1)).superRefine((tags, ctx) => {
  if (new Set(tags).size !== tags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate card tag" });
});
const PhysicalCardSchema = z.object({ id: z.string().min(1), attributes: z.object({ ...CardFaceSchema, source: z.literal("shoe") }).strict(), tags: CardTagsSchema }).strict()
  .refine((card) => !card.tags.includes("derived"), { path: ["tags"], message: "physical card cannot carry the derived tag" });
const DerivedCardSchema = z.object({ id: z.string().min(1), attributes: z.object({ ...CardFaceSchema, source: z.literal("derived") }).strict(), tags: CardTagsSchema }).strict()
  .refine((card) => card.tags.includes("derived"), { path: ["tags"], message: "derived card must carry the derived tag" });
const CardSchema = z.union([PhysicalCardSchema, DerivedCardSchema]);
const HandSchema = z.object({ cards: z.array(CardSchema) }).strict();
const RngSnapshotSchema = z.object({ seed: z.string(), state: z.number().int().min(0).max(0xffffffff) }).strict();
const CharacterIdSchema = z.string().min(1).refine((id) => getCharacterMetadata(id) !== undefined, "unknown character");
const HistoricalCharacterIdSchema = z.string().min(1);
const ShoeSchema = z.object({ cards: z.array(PhysicalCardSchema), cursor: z.number().int().min(0), shuffleIndex: z.number().int().min(0) }).strict()
  .refine((shoe) => shoe.cursor <= shoe.cards.length, "cursor cannot exceed cards length");
const GunSchema = z.object({ capacity: z.number().int().positive(), bullets: z.number().int().min(0) }).strict()
  .refine((gun) => gun.bullets <= gun.capacity, "bullets cannot exceed capacity");
const RouletteSchema = z.object({ player: GunSchema, opponent: GunSchema }).strict();
const ParticipantSchema = z.object({
  id: z.enum(["player", "opponent"]), hand: HandSchema, stood: z.boolean(), busted: z.boolean(), bustLimit: z.number().finite().optional()
}).strict();
function sameParticipant(left: z.infer<typeof ParticipantSchema>, right: z.infer<typeof ParticipantSchema>): boolean {
  return left.id === right.id && left.stood === right.stood && left.busted === right.busted && left.bustLimit === right.bustLimit
    && left.hand.cards.length === right.hand.cards.length
    && left.hand.cards.every((card, index) => {
      const other = right.hand.cards[index];
      return card.id === other.id && card.attributes.source === other.attributes.source
        && card.attributes.rank === other.attributes.rank && card.attributes.suit === other.attributes.suit
        && card.tags.length === other.tags.length && card.tags.every(tag => other.tags.includes(tag));
    });
}
const RoundOutcomeSchema = z.object({
  winner: z.enum(["player", "opponent"]).nullable(),
  reason: z.enum(["blackjack", "bust", "comparison", "push"]),
  penaltyTarget: z.enum(["player", "opponent"]).nullable(),
  bulletsAdded: z.number().int().min(0),
  comparisonScores: z.object({ player: z.number().finite(), opponent: z.number().finite() }).strict().optional(),
  pointAdvantages: z.object({ player: z.number().finite(), opponent: z.number().finite() }).strict().optional()
}).strict();
const RoundSchema = z.object({
  index: z.number().int().min(0),
  phase: z.enum(["dealing", "initial-blackjack-check", "turns", "settlement", "round-reveal", "roulette-reaction", "roulette-trigger", "roulette-result", "round-end"]),
  starter: z.enum(["player", "opponent"]),
  currentActor: z.enum(["player", "opponent"]).nullable(),
  player: ParticipantSchema,
  opponent: ParticipantSchema,
  outcome: RoundOutcomeSchema.nullable()
}).strict();
const AiProfileSchema = z.object({ P: z.number().finite(), A: z.number().finite(), B: z.number().finite(), C: z.number().finite() }).strict();
const AiNoiseSchema = z.object({ match: z.number().min(-0.3).max(0.3), play: z.number().min(-0.3).max(0.3) }).strict();
const AiDecisionSchema = z.object({
  actionOverride: z.object({ action: z.enum(["hit", "stand"]), sourceInstanceId: z.string().min(1) }).strict().optional(),
  handValue: z.number().int().min(0), threshold: z.number().finite(), bySkill: z.number().finite().default(0), bulletDifference: z.number().int(),
  matchNoise: z.number().min(-0.3).max(0.3), playNoise: z.number().min(-0.3).max(0.3), action: z.enum(["hit", "stand"])
}).strict();
const AbilityCardSchema = z.object({ level: AbilityLevelNumberSchema.default(1), kind: z.literal("player-skill"), definitionId: z.string().min(1), owner: z.literal("player"), instanceId: z.string().min(1) }).strict();
const AbilityInstanceSchema = z.object({
  level: AbilityLevelNumberSchema.default(1), intrinsic: z.boolean().optional(),
  kind: z.enum(["player-skill", "ai-skill", "talent"]), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]),
  instanceId: z.string().min(1), createdAtSequence: z.number().int().min(0), parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  ttl: z.object({ type: z.enum(["rounds", "triggers"]), remaining: z.number().int().min(0) }).strict().optional(),
  remainingUses: z.number().int().min(0).optional()
}).strict();
const AbilityStatusSchema = z.object({ statusDefinitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1), stacks: z.number().int().positive(), duration: z.enum(["turn", "round", "match", "until-owner-action", "until-consumed"]), parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])), createdAtSequence: z.number().int().min(0) }).strict();
const DisplayInstanceSchema = z.object({
  level: AbilityLevelNumberSchema.default(1),
  definitionId: z.string().min(1), displayId: z.string().min(1), owner: z.enum(["player", "opponent"]), target: z.enum(["player", "opponent"]),
  parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])), registeredAtSequence: z.number().int().min(0)
}).strict();
const AbilityRuntimeSchema = z.object({ displays: z.array(DisplayInstanceSchema), instances: z.array(AbilityInstanceSchema), statuses: z.array(AbilityStatusSchema), counters: z.record(z.string(), z.number().int().min(0)), sequence: z.number().int().min(0), catalogVersion: z.string().min(1), rng: RngSnapshotSchema, lastPlayedPlayerSkillDefinitionId: z.string().min(1).nullable(), lastPlayedPlayerSkillLevel: AbilityLevelNumberSchema.default(1) }).strict().superRefine((runtime, ctx) => {
  if (runtime.catalogVersion !== ABILITY_CATALOG_VERSION) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["catalogVersion"], message: "unsupported ability catalog version" });
  if (runtime.lastPlayedPlayerSkillDefinitionId !== null) {
    const definition = getAbilityDefinition(runtime.lastPlayedPlayerSkillDefinitionId, undefined, runtime.lastPlayedPlayerSkillLevel);
    if (!definition || definition.sourceKind !== "player-skill" || definition.activation.type !== "action") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lastPlayedPlayerSkillDefinitionId"], message: "last played Player Skill memory is invalid" });
  }
  const displayIds = new Set<string>();
  runtime.displays.forEach((display, index) => {
    const key = `${display.owner}:${display.definitionId}:${display.displayId}`;
    const definition = getAbilityDefinition(display.definitionId, undefined, display.level);
    const declaration = definition?.displays?.find((entry) => entry.id === display.displayId);
    const target = declaration?.target === "owner" ? display.owner : display.owner === "player" ? "opponent" : "player";
    if (displayIds.has(key) || !declaration || display.target !== target || display.registeredAtSequence > runtime.sequence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays", index], message: "invalid display registration" });
    if (definition && ((definition.sourceKind === "ai-skill") !== (display.owner === "opponent"))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays", index, "owner"], message: "display owner does not match source kind" });
    try { validateAbilityBinding({ definitionId: display.definitionId, level: display.level, enabled: true, parameters: display.parameters }); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays", index, "parameters"], message: "invalid display parameters" }); }
    displayIds.add(key);
  });
  const instanceIds = new Set<string>();
  runtime.instances.forEach((instance, index) => {
    if (instanceIds.has(instance.instanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "instanceId"], message: "duplicate ability instance id" });
    instanceIds.add(instance.instanceId);
    if (instance.createdAtSequence > runtime.sequence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "createdAtSequence"], message: "instance sequence exceeds runtime sequence" });
    const definition = getAbilityDefinition(instance.definitionId, undefined, instance.level);
    if (!definition && getAbilityDefinition(instance.definitionId)) ctx.addIssue({ code: "custom", path: ["instances", index, "level"], message: "unknown ability level" });
    if (!definition && !instance.intrinsic) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "definitionId"], message: "unknown ability definition" });
    if (instance.intrinsic && (instance.kind !== "player-skill" || instance.owner !== "player" || (definition && !(definition.sourceKind === "player-skill" && definition.hidden && !definition.drop.enabled && definition.activation.type === "automatic")))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "intrinsic"], message: "invalid intrinsic ability" });
    if (definition) {
      if (!supportsAbilitySourceKind(definition, instance.kind)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "kind"], message: "instance kind does not match definition source kind" });
      if (definition.sourceKind === "ai-skill" && instance.owner !== "opponent") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "owner"], message: "AI Skill runtime instances must be owned by the opponent" });
      if ((definition.sourceKind === "player-skill" || definition.sourceKind === "talent") && instance.owner !== "player") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "owner"], message: `${definition.sourceKind} runtime instances must be owned by the player` });
      if (definition.ttl && (!instance.ttl || instance.ttl.type !== definition.ttl.type || instance.ttl.remaining > definition.ttl.amount)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "ttl"], message: "instance TTL does not match its definition" });
      if (!definition.ttl && instance.ttl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "ttl"], message: "instance has TTL but its definition does not" });
      const configuredUses = definition.activation.type === "action" && definition.activation.consume === "card" ? definition.activation.uses ?? 1 : 1;
      if (configuredUses > 1 && (instance.remainingUses === undefined || instance.remainingUses > configuredUses)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "remainingUses"], message: "instance remaining uses do not match its definition" });
      if (configuredUses === 1 && instance.remainingUses !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "remainingUses"], message: "single-use ability instance cannot track remaining uses" });
      try { validateAbilityBinding({ definitionId: instance.definitionId, level: instance.level, enabled: true, parameters: instance.parameters }); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "parameters"], message: error instanceof Error ? error.message : "invalid ability parameters" }); }
    }
  });
  runtime.statuses.forEach((status, index) => {
    if (status.createdAtSequence > runtime.sequence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses", index, "createdAtSequence"], message: "status sequence exceeds runtime sequence" });
    if (!getStatusDefinition(status.statusDefinitionId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses", index, "statusDefinitionId"], message: "unknown status definition" });
    if (!instanceIds.has(status.sourceInstanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses", index, "sourceInstanceId"], message: "status source instance does not exist" });
  });
});

const GameEventSchema = z.union([
  z.object({ type: z.literal("SKILL_CARDS_REMOVED"), actor: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1), cards: z.array(AbilityCardSchema).min(1) }).strict().superRefine((event, ctx) => {
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
  z.object({ type: z.literal("CARD_DEALT"), actor: z.enum(["player", "opponent"]), card: CardSchema, private: z.boolean() }).strict(),
  z.object({ type: z.literal("INITIAL_BLACKJACK_CHECK"), player: z.boolean(), opponent: z.boolean() }).strict(),
  z.object({ type: z.literal("TURN_SKIPPED"), actor: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1) }).strict(),
  z.object({ type: z.enum(["PLAYER_HIT", "OPPONENT_HIT"]), value: z.number().int().min(0) }).strict(),
  z.object({ type: z.enum(["PLAYER_STOOD", "OPPONENT_STOOD"]) }).strict(),
  z.object({ type: z.literal("BLACKJACK"), actor: z.enum(["player", "opponent"]) }).strict(),
  z.object({ type: z.literal("BUST"), actor: z.enum(["player", "opponent"]) }).strict(),
  z.object({ type: z.literal("ROUND_RESOLVED"), outcome: RoundOutcomeSchema }).strict(),
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
  z.object({ type: z.literal("AI_DECISION"), decision: AiDecisionSchema }).strict()
]);

const PlayerSkillInventorySchema = z.object({
    unlockedDefinitionIds: z.array(z.string().min(1)), selectedSkillTags: z.array(z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"])).max(2), cards: z.array(AbilityCardSchema).max(PLAYER_SKILL_INVENTORY_CAPACITY),
    deckDefinitionIds: z.array(z.string().min(1)).optional(),
    acquisitionCounts: z.record(z.string().min(1), z.number().int().nonnegative().safe()).optional(),
    drawCount: z.number().int().min(0),
    openingCardCount: z.number().int().min(0).max(PLAYER_SKILL_INVENTORY_CAPACITY),
    refreshesPerDraw: z.number().int().nonnegative().safe(),
    drawOffer: z.object({ id: z.string().min(1), refreshesRemaining: z.number().int().nonnegative().safe(), candidateDefinitionIds: z.array(z.string().min(1)).min(1).max(3) }).strict().nullable(),
  }).strict().superRefine((skills, ctx) => {
    const acquisitionCount = (id: string) => skills.acquisitionCounts && Object.prototype.hasOwnProperty.call(skills.acquisitionCounts, id) ? skills.acquisitionCounts[id]! : 0;
    if (new Set(skills.selectedSkillTags).size !== skills.selectedSkillTags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedSkillTags"], message: "duplicate selected Skill Tag" });
    if (new Set(skills.unlockedDefinitionIds).size !== skills.unlockedDefinitionIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unlockedDefinitionIds"], message: "duplicate unlocked Player Skill" });
    for (const id of skills.unlockedDefinitionIds) if (!getPlayerSkillDefinition(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unlockedDefinitionIds"], message: "unknown Player Skill" });
    if (skills.deckDefinitionIds) {
      if (new Set(skills.deckDefinitionIds).size !== skills.deckDefinitionIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deckDefinitionIds"], message: "duplicate deck skill" });
      for (const id of skills.deckDefinitionIds) {
        const skill = getPlayerSkillDefinition(id);
        if (!skills.unlockedDefinitionIds.includes(id) || !skill?.drop.enabled || !(skill.drop.baseWeight > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deckDefinitionIds"], message: "invalid deck skill" });
      }
      if (skills.selectedSkillTags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedSkillTags"], message: "deck matches do not use legacy preferences" });
    }
    const instanceIds = new Set<string>();
    const passiveIds = new Set<string>();
    for (const [id, count] of Object.entries(skills.acquisitionCounts ?? {})) {
      const skill = getPlayerSkillDefinition(id);
      if (count < skills.cards.filter(card => card.definitionId === id).length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acquisitionCounts", id], message: "acquisition count is smaller than the held card count" });
      if (skill?.acquisitionLimit && count > skill.acquisitionLimit.perMatch) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acquisitionCounts", id], message: "acquisition count exceeds the definition's match limit" });
    }
    for (const [index, card] of skills.cards.entries()) {
      if (instanceIds.has(card.instanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, "instanceId"], message: "duplicate skill card instance" });
      instanceIds.add(card.instanceId);
      const skill = getPlayerSkillDefinition(card.definitionId);
      if (skill?.acquisitionLimit && acquisitionCount(skill.id) < skills.cards.filter(held => held.definitionId === skill.id).length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acquisitionCounts", skill.id], message: "limited skill is missing its acquisition count" });
      if (!skill) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, "definitionId"], message: "unknown Player Skill card" });
      else if (!skills.unlockedDefinitionIds.includes(skill.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, "definitionId"], message: "Player Skill card is not unlocked" });
      else if (skill.category === "passive" && !skill.stackable && passiveIds.has(skill.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index], message: "non-stackable passive Player Skill is duplicated" });
      else if (skill.category === "passive") passiveIds.add(skill.id);
    }
    const offer = skills.drawOffer;
    if (offer) {
      if (offer.refreshesRemaining > skills.refreshesPerDraw) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "refreshesRemaining"], message: "refresh budget exceeds per-draw allowance" });
      if (new Set(offer.candidateDefinitionIds).size !== offer.candidateDefinitionIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds"], message: "duplicate draw candidate" });
      offer.candidateDefinitionIds.forEach((id, index) => {
        const skill = getPlayerSkillDefinition(id);
        if (!skill || !(skills.deckDefinitionIds ?? skills.unlockedDefinitionIds).includes(id) || !skill.drop.enabled) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds", index], message: "draw candidate is not an unlocked droppable Player Skill" });
        else if (skill.category === "passive" && !skill.stackable && skills.cards.some((card) => card.definitionId === id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds", index], message: "held non-stackable passive cannot be offered" });
        else if (skill.acquisitionLimit && acquisitionCount(id) >= skill.acquisitionLimit.perMatch) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds", index], message: "acquisition-limited skill cannot be offered again" });
      });
      if (skills.drawCount === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawCount"], message: "an open draw requires an available draw count" });
      if (skills.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer"], message: "a full inventory cannot keep a draw open" });
    }
  });

export const MatchStateSchema = z.object({
  id: z.string().min(1), seed: z.string(), opponentId: CharacterIdSchema,
  autoSkipAfterStand: z.boolean().optional(),
  status: z.enum(["active", "finished"]), scene: z.enum(["lobby", "match"]),
  view: z.enum(["table", "execution-room", "match-summary"]), roundIndex: z.number().int().min(0),
  player: ParticipantSchema, opponent: ParticipantSchema, shoe: ShoeSchema, roulette: RouletteSchema,
  previousRoundPointAdvantages: z.object({ player: z.number().finite(), opponent: z.number().finite() }).strict().optional(),
  comparisonBonuses: z.object({ player: z.number().int().safe(), opponent: z.number().int().safe() }).strict().optional(),
  playerSkills: PlayerSkillInventorySchema,
  talentIds: z.array(z.string().min(1)), round: RoundSchema,
  abilities: AbilityRuntimeSchema,
  outcome: z.object({ winner: z.enum(["player", "opponent"]).nullable(), reason: z.enum(["player-killed", "opponent-killed", "escaped"]) }).strict().optional(),
  history: z.array(GameEventSchema),
  rng: z.object({ deck: RngSnapshotSchema, roulette: RngSnapshotSchema, ai: RngSnapshotSchema, loot: RngSnapshotSchema, dialogue: RngSnapshotSchema }).strict(),
  aiProfile: AiProfileSchema, aiNoise: AiNoiseSchema, lastAiDecision: AiDecisionSchema.nullable()
}).strict().superRefine((match, ctx) => {
  // Preserve the existing wire shape, but reject contradictory copies before
  // the reducer can overwrite one participant or round index with the other.
  if (match.roundIndex !== match.round.index) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["round", "index"], message: "round index disagrees with match roundIndex" });
  for (const actor of ["player", "opponent"] as const) {
    if (!sameParticipant(match[actor], match.round[actor])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["round", actor], message: "round participant disagrees with match participant" });
  }
  const shoeIds = new Set<string>();
  match.shoe.cards.forEach((card, index) => {
    if (shoeIds.has(card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shoe", "cards", index, "id"], message: "duplicate physical card id" });
    shoeIds.add(card.id);
  });
  const handIds = new Set<string>();
  (["player", "opponent"] as const).forEach((actor) => match[actor].hand.cards.forEach((card, index) => {
    if (handIds.has(card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [actor, "hand", "cards", index, "id"], message: "card id exists in multiple hand slots" });
    handIds.add(card.id);
    if (card.attributes.source === "derived" && shoeIds.has(card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [actor, "hand", "cards", index, "id"], message: "derived card cannot enter the physical shoe" });
  }));
  const instances = new Map(match.abilities.instances.map((instance) => [instance.instanceId, instance]));
  match.playerSkills.cards.forEach((card, index) => {
    const instance = instances.get(card.instanceId);
    if (!instance) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index, "instanceId"], message: "card runtime instance is missing" });
    else if (instance.kind !== "player-skill" || instance.definitionId !== card.definitionId || instance.owner !== card.owner || instance.level !== card.level) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index], message: "card does not match runtime instance" });
    else if (instance.ttl?.remaining === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index], message: "expired Player Skill cannot retain an inventory card" });
    else if (instance.remainingUses === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index], message: "exhausted Player Skill cannot retain an inventory card" });
  });
  match.abilities.instances.forEach((instance, index) => {
    const isStatusSource = match.abilities.statuses.some((status) => status.sourceInstanceId === instance.instanceId);
    const definition = getAbilityDefinition(instance.definitionId, undefined, instance.level);
    const intrinsic = definition?.sourceKind === "player-skill" && definition.hidden && !definition.drop.enabled && definition.activation.type === "automatic";
    if (instance.kind === "player-skill" && !instance.intrinsic && !intrinsic && !isStatusSource && !match.playerSkills.cards.some((card) => card.instanceId === instance.instanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["abilities", "instances", index], message: "Player Skill runtime instance has no card" });
  });
  if (match.playerSkills.drawOffer && (match.round.phase !== "turns" || match.round.currentActor !== "player")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "drawOffer"], message: "a skill draw can only be open during the player's turn" });
  if (new Set(match.talentIds).size !== match.talentIds.length || match.talentIds.some((id) => !getTalentDefinition(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["talentIds"], message: "invalid Talent list" });
  for (const id of match.talentIds) if (!match.abilities.instances.some((instance) => instance.kind === "talent" && instance.definitionId === id && instance.owner === "player")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["talentIds"], message: "Talent runtime instance is missing" });
});

export const SkillDeckSchema = z.object({
  carried: z.array(z.string().min(1)), reserve: z.array(z.string().min(1))
}).strict().superRefine((deck, ctx) => {
  const ids = [...deck.carried, ...deck.reserve];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate deck skill" });
});

export const PlayerProfileSchema = z.object({
  id: z.string().min(1), displayName: z.string().min(1), matchesPlayed: z.number().int().min(0),
  wins: z.number().int().min(0), skillDeck: SkillDeckSchema.optional(), selectedSkillTags: z.array(z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"])).max(2)
}).strict().superRefine((profile, ctx) => { if (new Set(profile.selectedSkillTags).size !== profile.selectedSkillTags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate selected Skill Tag" }); });
export const GameSettingsSchema = z.object({ soundEnabled: z.boolean(), musicVolume: z.number().min(0).max(1).optional(), reducedMotion: z.boolean(), autoSkipAfterStand: z.boolean().optional(), debugEngineEnabled: z.boolean().optional(), pluginSettings: PluginSettingsDataSchema.optional(), characterSkins: CharacterSkinPreferencesSchema.optional() }).strict();
export const TutorialProgressSchema = z.object({
  completedIds: z.array(z.string().min(1).max(128))
}).strict().superRefine((progress, ctx) => {
  if (new Set(progress.completedIds).size !== progress.completedIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completedIds"], message: "duplicate completed tutorial id" });
  }
});
export type PlayerProfile = z.infer<typeof PlayerProfileSchema>;
export type GameSettings = z.infer<typeof GameSettingsSchema>;
export type TutorialProgress = z.infer<typeof TutorialProgressSchema>;
const HistoryGunSchema = z.object({ capacity: z.number().int().positive(), bullets: z.number().int().min(0) }).strict()
  .refine((gun) => gun.bullets <= gun.capacity, "bullets cannot exceed capacity");
const HistoryCountsSchema = z.object({ player: z.number().int().min(0), opponent: z.number().int().min(0) }).strict();
export const MatchHistoryRecordSchema = z.object({
  id: z.string().min(1), timestamp: z.string().datetime({ offset: true }), opponentId: HistoricalCharacterIdSchema,
  winner: z.enum(["player", "opponent"]).nullable(), escaped: z.boolean(),
  finalRoulette: z.object({ player: HistoryGunSchema, opponent: HistoryGunSchema }).strict(),
  busts: HistoryCountsSchema, blackjacks: HistoryCountsSchema
}).strict();
export const CharacterDefeatRecordSchema = z.object({
  opponentId: HistoricalCharacterIdSchema,
  timestamp: z.string().datetime({ offset: true })
}).strict();
export type { MatchHistoryRecord } from "../core/match/history";
export type { CharacterDefeatRecord } from "../core/progression/defeats";
/** Opaque originals travel with exports; they are never executed or used as live game data. */
export const SaveRecoverySchema = z.object({ originals: z.array(z.unknown()), issues: z.array(z.string()) }).strict();
export const LongTermSaveSchema = z.object({
  format: z.literal(LONG_TERM_SAVE_FORMAT), schemaVersion: z.literal(CURRENT_LONG_TERM_SCHEMA_VERSION), gameVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  profile: PlayerProfileSchema, settings: GameSettingsSchema, skipTutorial: z.boolean(),
  tutorialProgress: TutorialProgressSchema.default({ completedIds: [] }),
  recovery: SaveRecoverySchema.optional(),
  characterSkinUnlocks: CharacterSkinUnlocksSchema.optional(),
  characterDefeatProgress: CharacterDefeatProgressSchema.optional(),
  matchResultReceipts: z.array(z.string().min(1)).refine(ids => new Set(ids).size === ids.length, "战绩确认收据不可重复").optional(),
  completedChallenges: z.array(z.string().min(1)).optional(),
  completedFlows: z.array(z.string().min(1)).optional(),
  history: z.array(MatchHistoryRecordSchema),
  defeats: z.array(CharacterDefeatRecordSchema)
}).strict().superRefine((save, ctx) => {
  const opponentIds = new Set<string>();
  save.defeats.forEach((record, index) => {
    if (opponentIds.has(record.opponentId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defeats", index, "opponentId"], message: "duplicate defeated character" });
    opponentIds.add(record.opponentId);
  });
});

const PlayerSkillCarryoverSchema = z.object({
  inventory: z.object(PlayerSkillInventorySchema.shape).omit({ drawOffer: true }).strict(),
  instances: z.array(AbilityInstanceSchema).max(PLAYER_SKILL_INVENTORY_CAPACITY),
  counters: z.record(z.string(), z.number().int().nonnegative()), sequence: z.number().int().nonnegative(),
  rng: RngSnapshotSchema, lootRng: RngSnapshotSchema,
  lastPlayedPlayerSkillDefinitionId: z.string().min(1).nullable(), lastPlayedPlayerSkillLevel: AbilityLevelNumberSchema.default(1)
}).strict().superRefine((source, ctx) => {
  const inventory = PlayerSkillInventorySchema.safeParse({ ...source.inventory, drawOffer: null });
  if (!inventory.success) ctx.addIssue({ code: "custom", message: inventory.error.issues[0]?.message ?? "invalid challenge inventory" });
  // Validate through the same interpreter contract, with no table effects or display state.
  const { inventory: _inventory, lootRng: _loot, ...abilities } = source;
  const valid = AbilityRuntimeSchema.safeParse({ ...abilities, displays: [], statuses: [], catalogVersion: ABILITY_CATALOG_VERSION });
  if (!valid.success) ctx.addIssue({ code: "custom", message: valid.error.issues[0]?.message ?? "invalid carried ability" });
  const cards = new Map(source.inventory.cards.map(card => [card.instanceId, card]));
  if (source.instances.length !== cards.size) ctx.addIssue({ code: "custom", message: "carried cards and instances must agree" });
  for (const instance of source.instances) {
    const card = cards.get(instance.instanceId);
    if (!card || instance.intrinsic || instance.kind !== "player-skill" || instance.owner !== "player"
      || card.definitionId !== instance.definitionId || card.level !== instance.level
      || instance.remainingUses === 0 || instance.ttl?.remaining === 0)
      ctx.addIssue({ code: "custom", message: "invalid carried skill card instance" });
  }
  for (const key of Object.keys(source.counters)) if (!key.endsWith(":match") || ![...cards.keys()].some(id => key.startsWith(`${id}:`)))
    ctx.addIssue({ code: "custom", message: "only carried-card match counters may survive" });
});

export const RuntimeSaveSchema = z.object({
  format: z.literal(RUNTIME_SAVE_FORMAT), schemaVersion: z.literal(CURRENT_RUNTIME_SCHEMA_VERSION), gameVersion: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true }), activeMatch: MatchStateSchema.nullable(),
  activeProgram: ProgramRunSchema.optional(),
  activeChallenge: StoredChallengeRunSchema.optional(),
  challengeMemory: z.object({ player: PlayerSkillCarryoverSchema.nullable() }).strict().optional(),
  activeFlow: StoredFlowRunSchema.optional(),
  flowMemory: z.object({ player: PlayerSkillCarryoverSchema.nullable() }).strict().optional()
}).strict().superRefine((save, ctx) => {
  const program = save.activeProgram;
  if (program) {
    if (save.activeFlow || save.activeChallenge || save.flowMemory || save.challengeMemory)
      ctx.addIssue({ code: "custom", message: "编排器必须是唯一的运行时所有者" });
    if (program.status === "finished" || program.pendingWrites.length)
      ctx.addIssue({ code: "custom", message: "完成与记账必须在同一事务提交" });
    const node = program.definition.nodes.find(node => node.id === program.cursor);
    if (save.activeMatch) {
      if (program.status !== "match" || node?.type !== "match" || save.activeMatch.id !== programMatchId(program) || save.activeMatch.opponentId !== node.opponentId || program.resources !== null || save.activeMatch.scene === "lobby")
        ctx.addIssue({ code: "custom", message: "牌局与编排节点不一致" });
    } else if (!program.resources) ctx.addIssue({ code: "custom", message: "非牌桌阶段缺少流程资源" });
    if (program.resources?.player && !PlayerSkillCarryoverSchema.safeParse(program.resources.player).success)
      ctx.addIssue({ code: "custom", message: "流程继承技能无效" });
    for (const receipt of program.results) {
      const source = program.definition.nodes.find(item => item.id === receipt.nodeId);
      if (!MatchStateSchema.safeParse(receipt.match).success || receipt.match.status !== "finished" || receipt.match.scene !== "lobby" || source?.type !== "match" || receipt.match.opponentId !== source.opponentId || receipt.match.id !== receipt.id)
        ctx.addIssue({ code: "custom", message: "流程结果收据无效" });
    }
    for (const item of program.definition.nodes) if (item.type === "match" && !getCharacterMetadata(item.opponentId))
      ctx.addIssue({ code: "custom", message: "流程角色已不可用" });
    return;
  }
  const run = save.activeChallenge;
  const flow = save.activeFlow;
  if (!run && !flow && !save.activeMatch) ctx.addIssue({ code: "custom", message: "运行时档缺少牌局或挑战" });
  if (flow && run) ctx.addIssue({ code: "custom", message: "运行时只能有一个流程所有者" });
  if (save.challengeMemory && !run) ctx.addIssue({ code: "custom", message: "challenge inventory requires an active challenge" });
  if (save.flowMemory && !flow) ctx.addIssue({ code: "custom", message: "flow inventory requires an active flow" });
  if (flow) {
    const backgroundCharacterId = flow.definition.presentation?.backgroundCharacterId;
    if (backgroundCharacterId && !getCharacterMetadata(backgroundCharacterId)) ctx.addIssue({ code: "custom", message: "流程背景角色已不可用" });
    const node = flow.definition.nodes.find(node => node.id === flow.encounter?.nodeId);
    if (flow.phase === "finished") ctx.addIssue({ code: "custom", message: "流程结束必须与运行时清理一起提交" });
    if (flow.phase === "encounter" ? !save.activeMatch || save.activeMatch.id !== flow.encounter?.matchId || save.activeMatch.opponentId !== node?.opponentId : save.activeMatch !== null)
      ctx.addIssue({ code: "custom", message: "流程与当前牌局不一致" });
    if (flow.phase === "encounter") {
      if (flow.playerGun !== undefined || save.flowMemory !== undefined)
        ctx.addIssue({ code: "custom", message: "战斗资源只属于当前牌局" });
      if (save.activeMatch?.scene === "lobby")
        ctx.addIssue({ code: "custom", message: "流程结算必须与阶段切换一起提交" });
      if (flow.encounter?.claimedRewards?.length && (save.activeMatch?.status !== "finished"
        || save.activeMatch.outcome?.winner !== "player" || save.activeMatch.outcome.reason !== "opponent-killed"))
        ctx.addIssue({ code: "custom", message: "仅胜利结算可以保存节点领奖收据" });
    } else if (!flow.playerGun || !save.flowMemory) {
      ctx.addIssue({ code: "custom", message: "选择阶段缺少继承资源" });
    } else if (flow.encounterIndex > 0 && save.flowMemory.player === null) {
      ctx.addIssue({ code: "custom", message: "已开局的流程缺少继承技能库存" });
    }
    for (const node of flow.definition.nodes) {
      if (!getCharacterMetadata(node.opponentId)) ctx.addIssue({ code: "custom", message: "流程角色已不可用" });
      for (const binding of (node.abilities ?? []).flatMap(slot => [slot.binding, ...slot.overrides.map(override => override.binding)])) {
        try {
          validateAbilityBinding(binding);
          const ability = getAbilityDefinition(binding.definitionId, undefined, binding.level);
          if (!ability || !supportsAbilitySourceKind(ability, "ai-skill")) throw new Error("not an AI skill");
        } catch { ctx.addIssue({ code: "custom", message: "流程技能已不可用" }); }
      }
    }
  }
  if (run) {
    const encounter = run.encounter;
    if (run.phase === "encounter" ? !save.activeMatch || save.activeMatch.id !== encounter?.matchId || save.activeMatch.opponentId !== encounter.characterId : save.activeMatch !== null)
      ctx.addIssue({ code: "custom", message: "挑战与当前牌局不一致" });
    if (run.phase === "encounter") {
      if (run.playerGun !== undefined || save.challengeMemory !== undefined)
        ctx.addIssue({ code: "custom", message: "战斗资源只属于当前牌局" });
      if (save.activeMatch?.scene === "lobby")
        ctx.addIssue({ code: "custom", message: "挑战结算必须与阶段切换一起提交" });
    } else if (!run.playerGun || !save.challengeMemory) {
      ctx.addIssue({ code: "custom", message: "选择阶段缺少继承资源" });
    }
    for (const id of [run.definition.bossId, ...run.definition.guards.map(guard => guard.characterId)]) {
      if (getCharacterMetadata(id)?.faction !== run.definition.faction) ctx.addIssue({ code: "custom", message: "挑战角色缺失或阵营不符" });
    }
    for (const binding of run.definition.bossAbilities.flatMap(ability => [ability.binding, ...(ability.weakenedBinding ? [ability.weakenedBinding] : [])])) {
      try {
        validateAbilityBinding(binding);
        const ability = getAbilityDefinition(binding.definitionId, undefined, binding.level);
        if (!ability || !supportsAbilitySourceKind(ability, "ai-skill")) throw new Error("not an AI skill");
      } catch { ctx.addIssue({ code: "custom", message: "挑战技能已不可用" }); }
    }
  }
});

export type LongTermSave = Omit<z.infer<typeof LongTermSaveSchema>, "history" | "defeats"> & { history: MatchHistoryRecord[]; defeats: CharacterDefeatRecord[] };
/** Runtime schema uses mutable arrays; the domain-facing save type preserves MatchState immutability. */
export type RuntimeSave = Omit<z.infer<typeof RuntimeSaveSchema>, "activeMatch" | "activeChallenge" | "challengeMemory" | "activeFlow" | "flowMemory" | "activeProgram"> & {
  activeProgram?: ProgramRun;
  activeMatch: MatchState | null; activeChallenge?: StoredChallengeRun; challengeMemory?: ChallengeMemory;
  activeFlow?: StoredFlowRun; flowMemory?: FlowMemory;
};
export type SaveKind = "long-term" | "runtime";

export class SaveValidationError extends Error {
  constructor(readonly kind: SaveKind, message: string, readonly input?: unknown) { super(message); this.name = "SaveValidationError"; }
}

export function validateLongTermSave(input: unknown): LongTermSave {
  const parsed = LongTermSaveSchema.safeParse(input);
  if (!parsed.success) throw new SaveValidationError("long-term", `Invalid long-term save data: ${parsed.error.issues[0]?.path.join(".") || "root"} ${parsed.error.issues[0]?.message ?? "unknown error"}`, input);
  return parsed.data as LongTermSave;
}

export function validateRuntimeSave(input: unknown): RuntimeSave {
  const parsed = RuntimeSaveSchema.safeParse(input);
  if (!parsed.success) throw new SaveValidationError("runtime", `Invalid runtime save data: ${parsed.error.issues[0]?.path.join(".") || "root"} ${parsed.error.issues[0]?.message ?? "unknown error"}`, input);
  return parsed.data as RuntimeSave;
}

export function assertMatchStateForSave(match: MatchState): MatchState {
  const result = MatchStateSchema.safeParse(match);
  if (!result.success) throw new SaveValidationError("runtime", `Cannot save invalid match state: ${result.error.issues[0]?.path.join(".") || "root"}`);
  return match;
}

export interface FlowMemory { readonly player: PlayerSkillCarryover | null; }
export type ChallengeMemory = FlowMemory;
