import { z } from "zod";
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
export const CURRENT_RUNTIME_SCHEMA_VERSION = 9 as const;
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
const RoundOutcomeSchema = z.object({
  winner: z.enum(["player", "opponent"]).nullable(),
  reason: z.enum(["blackjack", "bust", "comparison", "push"]),
  penaltyTarget: z.enum(["player", "opponent"]).nullable(),
  bulletsAdded: z.number().int().min(0),
  comparisonScores: z.object({ player: z.number().finite(), opponent: z.number().finite() }).strict().optional()
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
const AbilityCardSchema = z.object({ kind: z.literal("player-skill"), definitionId: z.string().min(1), owner: z.literal("player"), instanceId: z.string().min(1) }).strict();
const AbilityInstanceSchema = z.object({
  kind: z.enum(["player-skill", "ai-skill", "talent"]), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]),
  instanceId: z.string().min(1), createdAtSequence: z.number().int().min(0), parameters: z.record(z.union([z.string(), z.number().finite(), z.boolean()])),
  ttl: z.object({ type: z.enum(["rounds", "triggers"]), remaining: z.number().int().min(0) }).strict().optional(),
  remainingUses: z.number().int().min(0).optional()
}).strict();
const AbilityStatusSchema = z.object({ statusDefinitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1), stacks: z.number().int().positive(), duration: z.enum(["turn", "round", "match", "until-owner-action", "until-consumed"]), parameters: z.record(z.union([z.string(), z.number().finite(), z.boolean()])), createdAtSequence: z.number().int().min(0) }).strict();
const DisplayInstanceSchema = z.object({
  definitionId: z.string().min(1), displayId: z.string().min(1), owner: z.enum(["player", "opponent"]), target: z.enum(["player", "opponent"]),
  parameters: z.record(z.union([z.string(), z.number().finite(), z.boolean()])), registeredAtSequence: z.number().int().min(0)
}).strict();
const AbilityRuntimeSchema = z.object({ displays: z.array(DisplayInstanceSchema), instances: z.array(AbilityInstanceSchema), statuses: z.array(AbilityStatusSchema), counters: z.record(z.number().int().min(0)), sequence: z.number().int().min(0), catalogVersion: z.string().min(1), rng: RngSnapshotSchema, lastPlayedPlayerSkillDefinitionId: z.string().min(1).nullable() }).strict().superRefine((runtime, ctx) => {
  if (runtime.catalogVersion !== ABILITY_CATALOG_VERSION) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["catalogVersion"], message: "unsupported ability catalog version" });
  if (runtime.lastPlayedPlayerSkillDefinitionId !== null) {
    const definition = getAbilityDefinition(runtime.lastPlayedPlayerSkillDefinitionId);
    if (!definition || definition.sourceKind !== "player-skill" || definition.activation.type !== "action") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lastPlayedPlayerSkillDefinitionId"], message: "last played Player Skill memory is invalid" });
  }
  const displayIds = new Set<string>();
  runtime.displays.forEach((display, index) => {
    const key = `${display.owner}:${display.definitionId}:${display.displayId}`;
    const definition = getAbilityDefinition(display.definitionId);
    const declaration = definition?.displays?.find((entry) => entry.id === display.displayId);
    const target = declaration?.target === "owner" ? display.owner : display.owner === "player" ? "opponent" : "player";
    if (displayIds.has(key) || !declaration || display.target !== target || display.registeredAtSequence > runtime.sequence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays", index], message: "invalid display registration" });
    if (definition && ((definition.sourceKind === "ai-skill") !== (display.owner === "opponent"))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays", index, "owner"], message: "display owner does not match source kind" });
    try { validateAbilityBinding({ definitionId: display.definitionId, enabled: true, parameters: display.parameters }); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays", index, "parameters"], message: "invalid display parameters" }); }
    displayIds.add(key);
  });
  const instanceIds = new Set<string>();
  runtime.instances.forEach((instance, index) => {
    if (instanceIds.has(instance.instanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "instanceId"], message: "duplicate ability instance id" });
    instanceIds.add(instance.instanceId);
    if (instance.createdAtSequence > runtime.sequence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "createdAtSequence"], message: "instance sequence exceeds runtime sequence" });
    const definition = getAbilityDefinition(instance.definitionId);
    if (!definition) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "definitionId"], message: "unknown ability definition" });
    else {
      if (!supportsAbilitySourceKind(definition, instance.kind)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "kind"], message: "instance kind does not match definition source kind" });
      if (definition.sourceKind === "ai-skill" && instance.owner !== "opponent") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "owner"], message: "AI Skill runtime instances must be owned by the opponent" });
      if ((definition.sourceKind === "player-skill" || definition.sourceKind === "talent") && instance.owner !== "player") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "owner"], message: `${definition.sourceKind} runtime instances must be owned by the player` });
      if (definition.ttl && (!instance.ttl || instance.ttl.type !== definition.ttl.type || instance.ttl.remaining > definition.ttl.amount)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "ttl"], message: "instance TTL does not match its definition" });
      if (!definition.ttl && instance.ttl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "ttl"], message: "instance has TTL but its definition does not" });
      const configuredUses = definition.activation.type === "action" && definition.activation.consume === "card" ? definition.activation.uses ?? 1 : 1;
      if (configuredUses > 1 && (instance.remainingUses === undefined || instance.remainingUses > configuredUses)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "remainingUses"], message: "instance remaining uses do not match its definition" });
      if (configuredUses === 1 && instance.remainingUses !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "remainingUses"], message: "single-use ability instance cannot track remaining uses" });
      try { validateAbilityBinding({ definitionId: instance.definitionId, enabled: true, parameters: instance.parameters }); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instances", index, "parameters"], message: error instanceof Error ? error.message : "invalid ability parameters" }); }
    }
  });
  runtime.statuses.forEach((status, index) => {
    if (status.createdAtSequence > runtime.sequence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses", index, "createdAtSequence"], message: "status sequence exceeds runtime sequence" });
    if (!getStatusDefinition(status.statusDefinitionId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses", index, "statusDefinitionId"], message: "unknown status definition" });
    if (!instanceIds.has(status.sourceInstanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses", index, "sourceInstanceId"], message: "status source instance does not exist" });
  });
});

const GameEventSchema = z.union([
  z.object({ type: z.literal("ABILITY_PLAYED"), instanceId: z.string().min(1), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]) }).strict(),
  z.object({ type: z.literal("ABILITY_TRIGGERED"), instanceId: z.string().min(1), definitionId: z.string().min(1), ruleId: z.string().min(1), owner: z.enum(["player", "opponent"]) }).strict(),
  z.object({ type: z.literal("ABILITY_EXPIRED"), instanceId: z.string().min(1), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), reason: z.enum(["rounds", "triggers"]) }).strict(),
  z.object({ type: z.literal("ABILITY_RESOLUTION_FAILED"), instanceId: z.string().min(1), definitionId: z.string().min(1), ruleId: z.string().min(1), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal("STATUS_ADDED"), statusDefinitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), sourceInstanceId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("STATUS_REMOVED"), statusDefinitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), reason: z.enum(["consumed", "expired", "dispelled"]) }).strict(),
  z.object({ type: z.literal("PENDING_EVENT_MODIFIED"), eventId: z.string().min(1), effectType: z.string().min(1), sourceInstanceId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("PENDING_EVENT_CANCELLED"), eventId: z.string().min(1), sourceInstanceId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("CARD_SUIT_REVEALED"), viewer: z.enum(["player", "opponent"]), target: z.enum(["player", "opponent"]), cardId: z.string().min(1), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
  z.object({ type: z.literal("DRAW_PILE_CARD_SUIT_REVEALED"), viewer: z.enum(["player", "opponent"]), cardId: z.string().min(1), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
  z.object({ type: z.literal("DRAW_PILE_CARD_REVEALED"), viewer: z.enum(["player", "opponent"]), cardId: z.string().min(1), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
  z.object({ type: z.literal("ABILITY_RESULT"), instanceId: z.string().min(1), definitionId: z.string().min(1), owner: z.enum(["player", "opponent"]), result: z.union([
    z.object({ type: z.literal("derived-card-added"), actor: z.enum(["player", "opponent"]), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
    z.object({ type: z.literal("derived-card-replaced"), actor: z.enum(["player", "opponent"]), oldRank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
    z.object({ type: z.literal("status-stacks-updated"), actor: z.enum(["player", "opponent"]), statusDefinitionId: z.string().min(1), stacks: z.number().int().min(0), delta: z.number().int() }).strict(),
    z.object({ type: z.literal("skill-card-granted"), definitionId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("draw-pile-rotated") }).strict(),
    z.object({ type: z.literal("hit-bust-forecast"), actor: z.enum(["player", "opponent"]), wouldBust: z.boolean() }).strict(),
    z.object({ type: z.literal("hand-total-compared"), actor: z.enum(["player", "opponent"]), relation: z.enum(["higher", "equal", "lower"]) }).strict(),
    z.object({ type: z.literal("gun-bullets-added"), actor: z.enum(["player", "opponent"]), amount: z.number().int().min(0), bullets: z.number().int().min(0) }).strict()
  ]) }).strict(),
  z.object({ type: z.literal("ROUND_STARTED"), roundIndex: z.number().int().min(0) }).strict(),
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
  z.object({ type: z.literal("BULLET_ADDED"), actor: z.enum(["player", "opponent"]), amount: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal("TRIGGER_PULLED"), actor: z.enum(["player", "opponent"]), probability: z.number().min(0).max(1), baseProbability: z.number().min(0).max(1), misfireChance: z.number().min(0).max(1), result: z.enum(["fired", "empty-chamber", "misfire"]), fired: z.boolean() }).strict().superRefine((event, ctx) => {
    if (event.fired !== (event.result === "fired")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fired"], message: "trigger result and fired flag disagree" });
  }),
  z.object({ type: z.literal("TRIGGER_SURVIVED"), actor: z.enum(["player", "opponent"]) }).strict(),
  z.object({ type: z.literal("TRIGGER_RESULT_ACKNOWLEDGED") }).strict(),
  z.object({ type: z.literal("PARTICIPANT_KILLED"), actor: z.enum(["player", "opponent"]) }).strict(),
  z.object({ type: z.literal("SKILL_GAINED"), skillId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("SKILL_DRAWS_ADDED"), reason: z.enum(["blackjack", "win", "loss", "push"]), amount: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("SKILL_DRAW_OPENED"), offerId: z.string().min(1), candidateDefinitionIds: z.array(z.string().min(1)).min(1).max(3) }).strict(),
  z.object({ type: z.literal("SKILL_DRAW_RESOLVED"), offerId: z.string().min(1), selectedDefinitionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("MATCH_FINISHED"), reason: z.enum(["player-killed", "opponent-killed", "escaped"]) }).strict(),
  z.object({ type: z.literal("MATCH_ESCAPED"), }).strict(),
  z.object({ type: z.literal("MATCH_RESULT_ACKNOWLEDGED"), }).strict(),
  z.object({ type: z.literal("AI_DECISION"), decision: AiDecisionSchema }).strict()
]);

export const MatchStateSchema = z.object({
  id: z.string().min(1), seed: z.string(), opponentId: CharacterIdSchema,
  status: z.enum(["active", "finished"]), scene: z.enum(["lobby", "match"]),
  view: z.enum(["table", "execution-room", "match-summary"]), roundIndex: z.number().int().min(0),
  player: ParticipantSchema, opponent: ParticipantSchema, shoe: ShoeSchema, roulette: RouletteSchema,
  playerSkills: z.object({
    unlockedDefinitionIds: z.array(z.string().min(1)), selectedSkillTags: z.array(z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"])).max(2), cards: z.array(AbilityCardSchema).max(PLAYER_SKILL_INVENTORY_CAPACITY),
    drawCount: z.number().int().min(0),
    drawOffer: z.object({ id: z.string().min(1), candidateDefinitionIds: z.array(z.string().min(1)).min(1).max(3) }).strict().nullable(),
    advice: z.enum(["hit", "stand"]).nullable()
  }).strict().superRefine((skills, ctx) => {
    if (new Set(skills.selectedSkillTags).size !== skills.selectedSkillTags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedSkillTags"], message: "duplicate selected Skill Tag" });
    if (new Set(skills.unlockedDefinitionIds).size !== skills.unlockedDefinitionIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unlockedDefinitionIds"], message: "duplicate unlocked Player Skill" });
    for (const id of skills.unlockedDefinitionIds) if (!getPlayerSkillDefinition(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unlockedDefinitionIds"], message: "unknown Player Skill" });
    const instanceIds = new Set<string>();
    const passiveIds = new Set<string>();
    for (const [index, card] of skills.cards.entries()) {
      if (instanceIds.has(card.instanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, "instanceId"], message: "duplicate skill card instance" });
      instanceIds.add(card.instanceId);
      const skill = getPlayerSkillDefinition(card.definitionId);
      if (!skill) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, "definitionId"], message: "unknown Player Skill card" });
      else if (!skills.unlockedDefinitionIds.includes(skill.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, "definitionId"], message: "Player Skill card is not unlocked" });
      else if (skill.category === "passive" && !skill.stackable && passiveIds.has(skill.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index], message: "non-stackable passive Player Skill is duplicated" });
      else if (skill.category === "passive") passiveIds.add(skill.id);
    }
    const offer = skills.drawOffer;
    if (offer) {
      if (new Set(offer.candidateDefinitionIds).size !== offer.candidateDefinitionIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds"], message: "duplicate draw candidate" });
      offer.candidateDefinitionIds.forEach((id, index) => {
        const skill = getPlayerSkillDefinition(id);
        if (!skill || !skills.unlockedDefinitionIds.includes(id) || !skill.drop.enabled) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds", index], message: "draw candidate is not an unlocked droppable Player Skill" });
        else if (skill.category === "passive" && !skill.stackable && skills.cards.some((card) => card.definitionId === id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer", "candidateDefinitionIds", index], message: "held non-stackable passive cannot be offered" });
      });
      if (skills.drawCount === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawCount"], message: "an open draw requires an available draw count" });
      if (skills.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drawOffer"], message: "a full inventory cannot keep a draw open" });
    }
  }),
  talentIds: z.array(z.string().min(1)), round: RoundSchema,
  abilities: AbilityRuntimeSchema,
  outcome: z.object({ winner: z.enum(["player", "opponent"]).nullable(), reason: z.enum(["player-killed", "opponent-killed", "escaped"]) }).strict().optional(),
  history: z.array(GameEventSchema),
  rng: z.object({ deck: RngSnapshotSchema, roulette: RngSnapshotSchema, ai: RngSnapshotSchema, loot: RngSnapshotSchema, dialogue: RngSnapshotSchema }).strict(),
  aiProfile: AiProfileSchema, aiNoise: AiNoiseSchema, lastAiDecision: AiDecisionSchema.nullable()
}).strict().superRefine((match, ctx) => {
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
    else if (instance.kind !== "player-skill" || instance.definitionId !== card.definitionId || instance.owner !== card.owner) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index], message: "card does not match runtime instance" });
    else if (instance.ttl?.remaining === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index], message: "expired Player Skill cannot retain an inventory card" });
    else if (instance.remainingUses === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "cards", index], message: "exhausted Player Skill cannot retain an inventory card" });
  });
  match.abilities.instances.forEach((instance, index) => {
    const isStatusSource = match.abilities.statuses.some((status) => status.sourceInstanceId === instance.instanceId);
    if (instance.kind === "player-skill" && !isStatusSource && !match.playerSkills.cards.some((card) => card.instanceId === instance.instanceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["abilities", "instances", index], message: "Player Skill runtime instance has no card" });
  });
  if (match.playerSkills.drawOffer && (match.round.phase !== "turns" || match.round.currentActor !== "player")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["playerSkills", "drawOffer"], message: "a skill draw can only be open during the player's turn" });
  if (new Set(match.talentIds).size !== match.talentIds.length || match.talentIds.some((id) => !getTalentDefinition(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["talentIds"], message: "invalid Talent list" });
  for (const id of match.talentIds) if (!match.abilities.instances.some((instance) => instance.kind === "talent" && instance.definitionId === id && instance.owner === "player")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["talentIds"], message: "Talent runtime instance is missing" });
});

export const PlayerProfileSchema = z.object({
  id: z.string().min(1), displayName: z.string().min(1), matchesPlayed: z.number().int().min(0),
  wins: z.number().int().min(0), selectedSkillTags: z.array(z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"])).max(2)
}).strict().superRefine((profile, ctx) => { if (new Set(profile.selectedSkillTags).size !== profile.selectedSkillTags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate selected Skill Tag" }); });
export const GameSettingsSchema = z.object({ soundEnabled: z.boolean(), reducedMotion: z.boolean() }).strict();
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
export const LongTermSaveSchema = z.object({
  format: z.literal(LONG_TERM_SAVE_FORMAT), schemaVersion: z.literal(CURRENT_LONG_TERM_SCHEMA_VERSION), gameVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  profile: PlayerProfileSchema, settings: GameSettingsSchema, skipTutorial: z.boolean(),
  tutorialProgress: TutorialProgressSchema.default({ completedIds: [] }),
  history: z.array(MatchHistoryRecordSchema),
  defeats: z.array(CharacterDefeatRecordSchema)
}).strict().superRefine((save, ctx) => {
  const opponentIds = new Set<string>();
  save.defeats.forEach((record, index) => {
    if (opponentIds.has(record.opponentId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defeats", index, "opponentId"], message: "duplicate defeated character" });
    opponentIds.add(record.opponentId);
  });
});

export const RuntimeSaveSchema = z.object({
  format: z.literal(RUNTIME_SAVE_FORMAT), schemaVersion: z.literal(CURRENT_RUNTIME_SCHEMA_VERSION), gameVersion: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true }), activeMatch: MatchStateSchema
}).strict();

export type LongTermSave = Omit<z.infer<typeof LongTermSaveSchema>, "history" | "defeats"> & { history: MatchHistoryRecord[]; defeats: CharacterDefeatRecord[] };
/** Runtime schema uses mutable arrays; the domain-facing save type preserves MatchState immutability. */
export type RuntimeSave = Omit<z.infer<typeof RuntimeSaveSchema>, "activeMatch"> & { activeMatch: MatchState };
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
