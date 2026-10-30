import { z } from "zod";
import { AbilityBindingSchema } from "../abilities/schema";
import type { AbilityBinding } from "../abilities/types";
import type { PlayerSkillCarryover } from "../abilities/carryover";
import { getAbilityDefinition, supportsAbilitySourceKind, validateAbilityBinding } from "../abilities/registry";
import type { AiProfile } from "../ai/types";
import type { CreateMatchOptions } from "../match/reducer";
import type { GunState } from "../roulette/types";
import { getPlayerSkillDefinition } from "../skills/definitions";
import { skillDeckRequirement } from "../skills/deck";

const count = z.number().int().nonnegative().safe();
const gun = z.object({ capacity: count.refine(value => value > 0), bullets: count }).strict()
  .refine(value => value.bullets <= value.capacity, "轮盘装填不能超过容量");
const gunPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z.object({ mode: z.literal("reset") }).strict(),
  z.object({ mode: z.literal("replace"), value: gun }).strict()
]);
const source = z.discriminatedUnion("source", [
  z.object({ source: z.literal("profile") }).strict(),
  z.object({ source: z.literal("fixed"), ids: z.array(z.string().min(1)) }).strict()
]);
export const MatchInitSpecSchema = z.object({
  preset: z.enum(["profile", "empty"]).optional(),
  playerGun: gunPolicy.optional(), opponentGun: gunPolicy.optional(),
  playerSkills: z.object({
    mode: z.enum(["inherit", "reset", "replace"]), cards: z.array(AbilityBindingSchema).optional(),
    draws: count.optional(), openingCards: count.optional(), grantOpening: z.boolean().optional()
  }).strict().superRefine((value, ctx) => {
    if ((value.mode === "replace") !== (value.cards !== undefined))
      ctx.addIssue({ code: "custom", message: "仅 replace 模式必须指定 cards" });
  }).optional(),
  comparisonBonuses: z.object({ player: z.number().int().safe().optional(), opponent: z.number().int().safe().optional() }).strict().optional(),
  skillPool: source.optional(), talents: source.optional(),
  opponentAbilities: z.array(AbilityBindingSchema).optional(), intrinsicAbilities: z.array(AbilityBindingSchema).optional(),
  aiProfile: z.object({ P: z.number().finite(), A: z.number().finite(), B: z.number().finite(), C: z.number().finite() }).strict().optional()
}).strict();
export type MatchInitSpec = z.input<typeof MatchInitSpecSchema>;
export interface MatchInitResources {
  readonly gun: GunState;
  readonly player: PlayerSkillCarryover | null;
  readonly comparisonBonus: number;
}
export interface MatchInitInput {
  readonly id: string; readonly seed: string; readonly opponentId: string;
  readonly defaults?: MatchInitSpec; readonly init?: MatchInitSpec;
  readonly resources: MatchInitResources;
  readonly context: {
    readonly profile: CreateMatchOptions;
    readonly character: { readonly ai: AiProfile; readonly aiSkills: readonly AbilityBinding[] };
  };
}

export class IncompleteSkillDeckError extends Error {
  constructor(readonly missing: number) {
    super(`还需加入 ${missing} 种技能才能开始新对局`);
    this.name = "IncompleteSkillDeckError";
  }
}

function resolveGun(policy: MatchInitSpec["playerGun"], inherited: GunState | undefined): GunState {
  return gun.parse(policy?.mode === "replace" ? policy.value : policy?.mode === "reset" ? { capacity: 6, bullets: 0 } : inherited ?? { capacity: 6, bullets: 0 });
}
function checkedBindings(bindings: readonly AbilityBinding[], kind: "ai-skill" | "player-skill"): AbilityBinding[] {
  return bindings.map(binding => {
    const valid = validateAbilityBinding(binding);
    const definition = getAbilityDefinition(valid.definitionId, undefined, valid.level);
    if (!definition || !supportsAbilitySourceKind(definition, kind)) throw new Error(`初始化能力类型不匹配：${valid.definitionId}`);
    return valid;
  });
}
/** Resolves all authored sources before opening a table. No RNG or durable state is mutated. */
export function resolveMatchInit(input: MatchInitInput): { opponentId: string; seed: string; options: CreateMatchOptions } {
  const defaults = MatchInitSpecSchema.parse(input.defaults ?? {});
  const local = MatchInitSpecSchema.parse(input.init ?? {});
  // Policies and arrays replace as units; scalar comparison overrides merge by actor.
  const spec: MatchInitSpec = { ...defaults, ...local,
    comparisonBonuses: { ...defaults.comparisonBonuses, ...local.comparisonBonuses } };
  const profile = input.context.profile;
  const useProfile = spec.preset !== "empty";
  const skillPolicy = spec.playerSkills;
  let carryover = (skillPolicy?.mode ?? "inherit") === "inherit" ? input.resources.player ?? undefined : undefined;
  const pool = spec.skillPool?.source === "fixed" ? [...spec.skillPool.ids]
    : spec.skillPool?.source === "profile" || useProfile ? profile.skillDeckIds && [...profile.skillDeckIds] : [];
  const unlocked = spec.skillPool?.source === "fixed" ? [...spec.skillPool.ids]
    : spec.skillPool?.source === "profile" || useProfile ? profile.unlockedPlayerSkillIds && [...profile.unlockedPlayerSkillIds] : [];
  if (pool && (new Set(pool).size !== pool.length || pool.some(id => {
    const definition = getPlayerSkillDefinition(id);
    return !definition || !definition.drop.enabled || definition.drop.baseWeight <= 0 || (unlocked && !unlocked.includes(id));
  }))) throw new Error("初始化技能池必须包含不重复且有效的可抽取技能");
  if (spec.skillPool?.source !== "fixed" && (spec.skillPool?.source === "profile" || useProfile) && pool && unlocked && !carryover) {
    const available = unlocked.filter(id => { const definition = getPlayerSkillDefinition(id); return definition?.drop.enabled && definition.drop.baseWeight > 0; });
    const requirement = skillDeckRequirement({ carried: pool, reserve: [] }, available);
    if (requirement.missing) throw new IncompleteSkillDeckError(requirement.missing);
  }
  if (carryover && spec.skillPool) carryover = { ...carryover, inventory: { ...carryover.inventory,
    unlockedDefinitionIds: unlocked ?? carryover.inventory.unlockedDefinitionIds,
    ...(pool === undefined ? {} : { deckDefinitionIds: pool }), selectedSkillTags: [] } };
  const talentIds = spec.talents?.source === "fixed" ? [...spec.talents.ids]
    : spec.talents?.source === "profile" || useProfile ? [...(profile.talentIds ?? [])] : [];
  if (new Set(talentIds).size !== talentIds.length || talentIds.some(id => { const definition = getAbilityDefinition(id); return !definition || !supportsAbilitySourceKind(definition, "talent"); }))
    throw new Error("初始化天赋必须包含不重复且有效的天赋");
  const opponentAiSkills = checkedBindings(spec.opponentAbilities ?? input.context.character.aiSkills, "ai-skill");
  const intrinsicMap = new Map((useProfile ? profile.intrinsicAbilities ?? [] : []).map(binding => [binding.definitionId, binding]));
  for (const binding of [...(defaults.intrinsicAbilities ?? []), ...(local.intrinsicAbilities ?? [])]) intrinsicMap.set(binding.definitionId, binding);
  const intrinsicAbilities = checkedBindings([...intrinsicMap.values()], "player-skill");
  for (const binding of intrinsicAbilities) {
    const definition = getAbilityDefinition(binding.definitionId, undefined, binding.level)!;
    if (definition.sourceKind !== "player-skill" || !definition.hidden || definition.drop.enabled || definition.activation.type !== "automatic") throw new Error(`初始化固有能力无效：${binding.definitionId}`);
  }
  const initialPlayerSkills = skillPolicy?.mode === "replace" ? checkedBindings(skillPolicy.cards!, "player-skill") : undefined;
  const comparisonBonuses = { player: spec.comparisonBonuses?.player ?? input.resources.comparisonBonus, opponent: spec.comparisonBonuses?.opponent ?? 0 };
  if (Object.values(comparisonBonuses).some(value => !Number.isSafeInteger(value))) throw new Error("初始化点数优势必须为安全整数");
  return { opponentId: input.opponentId, seed: input.seed, options: {
    id: input.id, opponentId: input.opponentId,
    autoSkipAfterStand: profile.autoSkipAfterStand ?? true,
    aiProfile: spec.aiProfile ?? input.context.character.ai,
    playerGun: resolveGun(spec.playerGun, input.resources.gun), opponentGun: resolveGun(spec.opponentGun, profile.opponentGun),
    unlockedPlayerSkillIds: unlocked, skillDeckIds: pool, talentIds, opponentAiSkills, intrinsicAbilities,
    comparisonBonuses, playerCarryover: carryover,
    ...(initialPlayerSkills === undefined ? {} : { initialPlayerSkills }),
    ...(skillPolicy?.draws === undefined ? {} : { initialSkillDraws: skillPolicy.draws }),
    ...(skillPolicy?.openingCards === undefined ? {} : { openingSkillCards: skillPolicy.openingCards }),
    grantOpeningSkills: skillPolicy?.grantOpening ?? (!carryover && skillPolicy?.mode !== "replace")
  } };
}
