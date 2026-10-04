import { z } from "zod";
import type { AbilityBinding, AbilityDefinition, Condition, ScalarValue } from "./types";

const actorSelector = z.enum(["owner", "rival", "event-actor", "penalty-target"]);
export const ScalarSchema: z.ZodType<ScalarValue> = z.lazy(() => z.union([z.number().finite(), z.object({ type: z.literal("constant"), value: z.number().finite() }).strict(), z.object({ type: z.literal("parameter"), key: z.string().min(1) }).strict(), z.object({ type: z.enum(["gun-bullets", "hand-total", "round-final-score", "hand-card-count", "event-hand-card-count", "round-hit-count"]), target: actorSelector }).strict(), z.object({ type: z.literal("hand-card-color-count"), target: actorSelector, color: z.enum(["red", "black"]) }).strict(), z.object({ type: z.literal("hand-card-suit-count"), target: actorSelector, suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(), z.object({ type: z.literal("hand-card-status-suit-count"), target: actorSelector, statusTarget: actorSelector, statusDefinitionId: z.string().min(1) }).strict(), z.object({ type: z.literal("status-stacks"), target: actorSelector, statusDefinitionId: z.string().min(1) }).strict(), z.object({ type: z.enum(["add", "subtract", "multiply", "power", "min", "max"]), left: ScalarSchema, right: ScalarSchema }).strict()])) as z.ZodType<ScalarValue>;
const scalar = ScalarSchema;
const compare = z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]);
const trigger = z.enum(["on-round-start", "before-bust-resolution", "on-match-created", "on-ability-gained", "on-ability-played", "after-ability-played", "before-turn", "before-ai-decision", "before-card-draw", "after-card-draw", "after-draw-pile-changed", "after-hand-changed", "after-stand", "before-bust-check", "before-round-resolution", "before-bullet-load", "after-bullet-load", "before-trigger-pull", "after-trigger-result", "on-round-end"]);
const candidate = z.union([
  z.object({ type: z.literal("resulting-hand-total-at-most"), value: scalar }).strict(),
  z.object({ type: z.literal("resulting-hand-total-exactly"), value: scalar }).strict()
]);
const rank = z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]);
const rankKeys = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const rankMap = z.object(Object.fromEntries(rankKeys.map((key) => [key, rank])) as Record<(typeof rankKeys)[number], typeof rank>).strict();
const derivedRank = z.union([
  z.object({ type: z.literal("static"), rank }).strict(),
  z.object({ type: z.literal("scalar"), value: scalar }).strict(),
  z.object({ type: z.literal("map-card-rank"), card: z.enum(["last-card", "first-private-card"]), map: rankMap }).strict()
]);
const derivedSuit = z.union([
  z.object({ type: z.literal("static"), suit: z.enum(["spades", "hearts", "diamonds", "clubs"]) }).strict(),
  z.object({ type: z.literal("uniform-ability-rng") }).strict()
]);
const condition: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ type: z.literal("actor-is"), actor: actorSelector }).strict(),
  z.object({ type: z.literal("owner-has-card"), abilityId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("hand-card-count"), target: actorSelector, operator: compare, value: scalar }).strict(),
  z.object({ type: z.literal("event-hand-card-count"), target: actorSelector, operator: compare, value: scalar }).strict(),
  z.object({ type: z.literal("hand-total"), target: actorSelector, operator: compare, value: scalar }).strict(),
  z.object({ type: z.literal("round-hit-count"), target: actorSelector, operator: compare, value: scalar }).strict(),
  z.object({ type: z.literal("hand-all-same-suit"), target: actorSelector }).strict(),
  z.object({ type: z.literal("hand-all-color"), target: actorSelector, color: z.enum(["red", "black"]) }).strict(),
  z.object({ type: z.literal("hand-rank-has-suit-partner"), target: actorSelector, rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]) }).strict(),
  z.object({ type: z.literal("draw-pile-card-exists") }).strict(),
  z.object({ type: z.literal("hand-last-card-splittable"), target: actorSelector }).strict(),
  z.object({ type: z.literal("hand-card-source-is"), target: actorSelector, card: z.literal("last-card"), source: z.enum(["shoe", "derived"]) }).strict(),
  z.object({ type: z.literal("hand-card-has-tag"), target: actorSelector, card: z.enum(["last-card", "first-private-card"]), tag: z.string().min(1) }).strict(),
  z.object({ type: z.literal("card-candidate-exists"), target: actorSelector, card: z.literal("last-card"), source: z.literal("remaining-draw-pile"), candidate }).strict(),
  z.object({ type: z.literal("hand-is-twenty-one"), target: actorSelector }).strict(),
  z.object({ type: z.literal("pending-turn-can-skip"), target: actorSelector }).strict(),
  z.object({ type: z.literal("next-hit-would-bust"), target: actorSelector }).strict(),
  z.object({ type: z.literal("pending-bust-would-bust"), target: actorSelector }).strict(),
  z.object({ type: z.literal("status-card-rank-is"), target: actorSelector, statusDefinitionId: z.string().min(1), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]) }).strict(),
  z.object({ type: z.literal("gun-bullets"), target: actorSelector, operator: compare, value: scalar }).strict(),
  z.object({ type: z.literal("gun-is-full"), target: actorSelector, expected: z.boolean() }).strict(),
  z.object({ type: z.literal("round-reason-is"), value: z.enum(["blackjack", "bust", "comparison", "push"]) }).strict(),
  z.object({ type: z.literal("round-penalty-target-is"), target: actorSelector }).strict(),
  z.object({ type: z.literal("event-ability-kind-is"), kind: z.enum(["player-skill", "ai-skill", "talent"]) }).strict(),
  z.object({ type: z.literal("status-present"), target: actorSelector, statusDefinitionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("scalar-compare"), left: scalar, operator: compare, right: scalar }).strict(),
  z.object({ type: z.literal("any"), conditions: z.array(condition) }).strict(),
  z.object({ type: z.literal("not"), condition }).strict()
]));
const effect = z.union([
  z.object({ type: z.literal("set-pending-ai-action"), target: actorSelector, action: z.enum(["hit", "stand"]) }).strict(),
  z.object({ type: z.literal("redeal-initial-hand"), target: actorSelector }).strict(),
  z.object({ type: z.literal("skip-turn"), target: actorSelector }).strict(),
  z.object({ type: z.literal("add-to-pending-ai-threshold"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("add-skill-draws"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("publish-action-advice"), target: actorSelector, policy: z.literal("current-optimal-hit-stand") }).strict(),
  z.object({ type: z.literal("reveal-draw-pile-top-suit"), viewer: actorSelector }).strict(),
  z.object({ type: z.literal("publish-hit-bust-forecast"), target: actorSelector }).strict(),
  z.object({ type: z.literal("publish-hand-total-comparison"), target: actorSelector }).strict(),
  z.object({ type: z.literal("replace-hand-card"), target: actorSelector, card: z.literal("last-card"), source: z.literal("remaining-draw-pile"), candidate, pick: z.literal("uniform-ability-rng") }).strict(),
  z.object({ type: z.literal("swap-last-hand-card-with-draw-pile-top"), target: actorSelector }).strict(),
  z.object({ type: z.literal("transfer-last-physical-hand-card"), from: actorSelector, target: actorSelector }).strict(),
  z.object({ type: z.literal("reveal-hand-card-suit"), target: actorSelector, card: z.enum(["first-private-card", "all-current-cards"]), viewer: actorSelector }).strict(),
  z.object({ type: z.literal("split-last-card-into-derived"), target: actorSelector }).strict(),
  z.object({ type: z.literal("add-status"), target: actorSelector, statusDefinitionId: z.string().min(1), parameters: z.record(z.union([z.string(), z.number().finite(), z.boolean()])).optional() }).strict(),
  z.object({ type: z.literal("set-status-suit-to-hand-majority"), target: actorSelector, handTarget: actorSelector, statusDefinitionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("set-status-stacks"), target: actorSelector, statusDefinitionId: z.string().min(1), amount: scalar }).strict(),
  z.object({ type: z.literal("remove-status"), target: actorSelector, statusDefinitionId: z.string().min(1), amount: scalar.optional() }).strict(),
  z.object({ type: z.literal("replace-pending-draw"), target: actorSelector, policy: z.object({ type: z.literal("exact-resulting-total"), total: scalar, fallback: z.literal("create-derived-card") }).strict() }).strict(),
  z.object({ type: z.literal("remember-last-card"), target: actorSelector, cardTarget: actorSelector, statusDefinitionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("replace-bust-hand-card-with-memory-card"), target: actorSelector, statusDefinitionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("add-derived-card-for-exact-total"), target: actorSelector, total: scalar }).strict(),
  z.object({ type: z.literal("add-derived-card"), target: actorSelector, rank: derivedRank, suit: derivedSuit }).strict(),
  z.object({ type: z.literal("copy-last-hand-card-as-derived"), target: actorSelector }).strict(),
  z.object({ type: z.literal("replace-hand-card-with-derived"), target: actorSelector, card: z.literal("last-card"), rank: derivedRank, suit: derivedSuit }).strict(),
  z.object({ type: z.enum(["add-hand-card-tag", "remove-hand-card-tag"]), target: actorSelector, card: z.enum(["last-card", "first-private-card"]), tag: z.string().min(1) }).strict(),
  z.object({ type: z.literal("rotate-draw-pile-top-to-bottom") }).strict(),
  z.object({ type: z.literal("grant-player-skill-card"), target: actorSelector, source: z.literal("last-successful-player-skill"), fallback: z.literal("self") }).strict(),
  z.object({ type: z.literal("add-to-pending-bust-limit"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("add-to-pending-trigger-misfire-chance"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("add-to-pending-load"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("set-pending-load"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("multiply-pending-load"), target: actorSelector, factor: scalar }).strict(),
  z.object({ type: z.literal("add-gun-bullets"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("add-to-pending-comparison-score"), target: actorSelector, amount: scalar }).strict(),
  z.object({ type: z.literal("cancel-pending-trigger"), target: actorSelector }).strict()
]);
const limit = z.object({ perEvent: z.number().int().positive().optional(), perTurn: z.number().int().positive().optional(), perRound: z.number().int().positive().optional(), perMatch: z.number().int().positive().optional() }).strict();
export const AbilityRuleSchema = z.object({ id: z.string().min(1), trigger, priority: z.number().int().optional(), notify: z.boolean().optional(), triggerNotice: z.string().min(1).optional(), conditions: z.array(condition).optional(), effects: z.array(effect).min(1), limit: limit.optional() }).strict();
const parameterSpec = z.union([
  z.object({ type: z.literal("number"), minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), default: z.number().finite().optional() }).strict().superRefine((value, ctx) => { if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minimum cannot exceed maximum" }); if (value.default !== undefined && ((value.minimum !== undefined && value.default < value.minimum) || (value.maximum !== undefined && value.default > value.maximum))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "default is outside parameter range" }); }),
  z.object({ type: z.literal("boolean"), default: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("enum"), values: z.array(z.string().min(1)).min(1), default: z.string().optional() }).strict().superRefine((value, ctx) => { if (value.default !== undefined && !value.values.includes(value.default)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enum default must be one of values" }); })
]);
const activation = z.union([
  z.object({ type: z.literal("action"), windows: z.array(z.enum(["owner-turn", "owner-roulette-reaction"])).min(1), consume: z.enum(["card", "none"]), uses: z.number().int().positive().optional(), availability: z.array(condition).optional() }).strict(),
  z.object({ type: z.literal("automatic") }).strict(), z.object({ type: z.literal("passive") }).strict()
]);
const abilityTtl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rounds"), amount: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("triggers"), amount: z.number().int().positive() }).strict()
]);
const primaryDomain = z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"]);
const tags = z.array(z.string().min(1)).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ability tags must be unique" });
});
const skillTag = z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"]);
const skillDrawWeightModifier = z.object({ tag: skillTag, factor: z.number().finite().nonnegative() }).strict();
const displayActor = z.enum(["owner", "rival"]);
const displayValue = z.union([
  scalar,
  z.object({ type: z.literal("constant"), value: z.union([z.string(), z.boolean()]) }).strict(),
  z.object({ type: z.literal("status-parameter"), target: displayActor, statusDefinitionId: z.string().min(1), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal("hand-card-attribute"), target: displayActor, card: z.enum(["last-card", "first-private-card"]), attribute: z.enum(["rank", "suit", "source"]) }).strict()
]).superRefine((value, ctx) => {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ((record.target !== undefined && record.target !== "owner" && record.target !== "rival") ||
        (record.statusTarget !== undefined && record.statusTarget !== "owner" && record.statusTarget !== "rival") || record.type === "event-hand-card-count") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Display queries require stable actors and facts" });
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
});
export const AbilityDisplaySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), target: displayActor, description: z.string().min(1),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("number"), value: displayValue, format: z.enum(["number", "percent"]).optional() }).strict(),
    z.object({ type: z.literal("suit"), value: displayValue }).strict(),
    z.object({ type: z.literal("card"), rank: displayValue, suit: displayValue, format: z.enum(["inline", "compact"]).optional() }).strict()
  ])).min(1),
  cardMarkers: z.array(z.object({ targets: z.array(displayActor).min(1), suit: displayValue, type: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), label: z.string().min(1) }).strict()).optional()
}).strict();
const definitionBase = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), name: z.string().min(1), description: z.string().min(1),
  usage: z.string().min(1).optional(), triggerNotice: z.string().min(1).optional(), profileLore: z.string().min(1).optional(), hidden: z.boolean().default(false),
  primaryDomain, tags, parameters: z.record(parameterSpec).optional(), activation, ttl: abilityTtl.optional(), rules: z.array(AbilityRuleSchema),
  displays: z.array(AbilityDisplaySchema).optional(),
  skillDrawWeightModifiers: z.array(skillDrawWeightModifier).optional()
});
const playerSkillDefinition = definitionBase.extend({
  sourceKind: z.literal("player-skill"), drop: z.object({ enabled: z.boolean(), baseWeight: z.number().finite().positive() }).strict(), stackable: z.boolean().default(false),
  skillTags: skillTag.array().min(1).superRefine((values, ctx) => { if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Player Skill skillTags must be unique" }); }),
  unlock: z.object({ opponentId: z.string().min(1), label: z.string().min(1) }).strict().optional()
}).strict();
const aiSkillDefinition = definitionBase.extend({ sourceKind: z.literal("ai-skill") }).strict();
const talentDefinition = definitionBase.extend({ sourceKind: z.literal("talent"), unlock: z.object({ type: z.literal("defeat-count"), count: z.number().int().positive(), label: z.string().min(1) }).strict() }).strict();
export const AbilityDefinitionSchema = z.discriminatedUnion("sourceKind", [playerSkillDefinition, aiSkillDefinition, talentDefinition]).superRefine((definition, ctx) => {
  if (new Set(definition.displays?.map((display) => display.id)).size !== (definition.displays?.length ?? 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displays"], message: "Duplicate display id" });
  if (definition.sourceKind === "player-skill" && definition.skillTags[0] !== definition.primaryDomain) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skillTags", 0], message: "Player Skill primaryDomain must match its first skillTag" });
  if (definition.sourceKind === "talent" && definition.ttl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttl"], message: "Talents cannot expire inside a match" });
  if (definition.activation.type === "action" && definition.ttl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttl"], message: "Active abilities are consumed explicitly and cannot declare TTL" });
  if (definition.sourceKind !== "talent" && definition.activation.type === "passive" && !definition.ttl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttl"], message: "Passive skills must declare TTL" });
  if (definition.activation.type !== "action") return;
  if (definition.sourceKind === "player-skill" && definition.activation.consume !== "card") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activation", "consume"], message: "player-skill actions must consume a card" });
  if (definition.sourceKind !== "player-skill" && definition.activation.consume !== "none") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activation", "consume"], message: `${definition.sourceKind} actions cannot consume a player card` });
  if (definition.sourceKind !== "player-skill" && definition.activation.uses !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activation", "uses"], message: "only Player Skill cards can declare multiple uses" });
});
export const StatusDefinitionSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), rules: z.array(AbilityRuleSchema), defaultDuration: z.enum(["turn", "round", "match", "until-owner-action", "until-consumed"]), blocksAbilityTags: z.array(z.string().min(1)).optional(), blocksActions: z.array(z.enum(["hit", "stand"])).min(1).refine((actions) => new Set(actions).size === actions.length, "Duplicate blocked action").optional() }).strict();
export const AbilityBindingSchema = z.object({ definitionId: z.string().min(1), enabled: z.boolean(), parameters: z.record(z.union([z.string(), z.number().finite(), z.boolean()])) }).strict();

export type AbilityDefinitionInput = z.infer<typeof AbilityDefinitionSchema>;
export type StatusDefinitionInput = z.infer<typeof StatusDefinitionSchema>;

export function validateBinding(binding: unknown, definition: AbilityDefinition | AbilityDefinitionInput): AbilityBinding {
  const parsed = AbilityBindingSchema.parse(binding) as AbilityBinding;
  const specs = definition.parameters ?? {};
  for (const key of Object.keys(parsed.parameters)) if (!Object.hasOwn(specs, key)) throw new Error(`Unknown parameter ${key} for ability ${definition.id}`);
  for (const [key, spec] of Object.entries(specs)) {
    const value = parsed.parameters[key];
    if (value === undefined) { if (spec.default === undefined) throw new Error(`Missing parameter ${key} for ability ${definition.id}`); continue; }
    if (spec.type === "number" && (typeof value !== "number" || (spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) throw new Error(`Invalid parameter ${key} for ability ${definition.id}`);
    if (spec.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid parameter ${key} for ability ${definition.id}`);
    if (spec.type === "enum" && (typeof value !== "string" || !spec.values.includes(value))) throw new Error(`Invalid parameter ${key} for ability ${definition.id}`);
  }
  const parameters: Record<string, string | number | boolean> = { ...parsed.parameters };
  for (const [key, spec] of Object.entries(specs)) if (parameters[key] === undefined && spec.default !== undefined) parameters[key] = spec.default;
  return { ...parsed, parameters };
}
