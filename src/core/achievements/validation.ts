import { AchievementDefinitionSchema, AchievementObservationContractSchema } from "./schema";
import type { AchievementCondition, AchievementDefinition, AchievementDiagnostic, AchievementNumber, AchievementObservation,
  AchievementObservationContract, AchievementTrack, AchievementValue } from "./types";

function sameTopic(a: AchievementObservationContract["topic"], b: AchievementObservationContract["topic"]): boolean {
  return a.type === b.type && a.apiVersion === b.apiVersion;
}
/** A declaration describes available semantic names, never arbitrary object property paths. */
export function validateAchievementInputs(definition: AchievementDefinition, contracts: readonly AchievementObservationContract[]): readonly AchievementDiagnostic[] {
  const parsed = AchievementDefinitionSchema.parse(definition);
  const inputs = contracts.map(contract => AchievementObservationContractSchema.parse(contract));
  const issues: AchievementDiagnostic[] = [];
  const report = (code: string, message: string) => { if (!issues.some(issue => issue.code === code && issue.message === message)) issues.push({ code, message }); };
  const hasTopic = (ref: AchievementObservationContract["topic"]) => {
    if (!inputs.some(input => sameTopic(input.topic, ref))) report("unsupported-topic", `未注册观察主题：${ref.type} API ${ref.apiVersion}`);
  };
  const fieldTypes = (key: string, available: readonly AchievementObservationContract[]) => {
    const types = new Set(available.flatMap(input => {
      if (!Object.hasOwn(input.values, key)) return [];
      const declared = input.values[key]!;
      return typeof declared === "string" ? [declared] : [...declared];
    }));
    if (!types.size) report("unknown-observation", `未声明的观察值：${key}`);
    return types;
  };
  const readNumber = (node: AchievementNumber, available: readonly AchievementObservationContract[]): void => {
    if (typeof node === "number") return;
    if (node.type === "observation") {
      if (!fieldTypes(node.key, available).has("number")) report("observation-type", `数值表达式需要 number 观察值：${node.key}`);
    } else if (node.type === "skill-card-count") {
      if (!available.some(input => input.skillCollections.includes(node.collection))) report("unknown-skill-collection", `未声明的技能集合：${node.collection}`);
    } else if ("left" in node) { readNumber(node.left, available); readNumber(node.right, available); }
    else if ("value" in node && typeof node.value !== "number") readNumber(node.value, available);
  };
  const readValue = (node: AchievementValue, available: readonly AchievementObservationContract[]): void => {
    if (node.type === "numeric") readNumber(node.value, available);
    if (node.type === "observation") fieldTypes(node.key, available);
  };
  const readCondition = (node: AchievementCondition | undefined, available: readonly AchievementObservationContract[]): void => {
    if (!node) return;
    if (node.type === "all" || node.type === "any") node.conditions.forEach(child => readCondition(child, available));
    else if (node.type === "not") readCondition(node.condition, available);
    else if (node.type === "topic-is") hasTopic(node.topic);
    else if (node.type === "available") fieldTypes(node.key, available);
    else if (node.type === "scalar-compare") { readNumber(node.left, available); readNumber(node.right, available); }
    else if (node.type === "value-compare") { readValue(node.left, available); readValue(node.right, available); }
  };
  const readTrack = (track: AchievementTrack): void => {
    track.on?.forEach(hasTopic);
    const available = track.on ? inputs.filter(input => track.on!.some(ref => sameTopic(input.topic, ref))) : inputs;
    readCondition(track.when, available);
    if (track.progress.type === "sum" || track.progress.type === "max") readNumber(track.progress.value, available);
    if (track.progress.type === "distinct") readValue(track.progress.value, available);
  };
  parsed.tracking.tracks.forEach(readTrack);
  for (const condition of [parsed.tracking.completeWhen, parsed.tracking.resetWhen, parsed.tracking.invalidateWhen]) readCondition(condition, inputs);
  return issues;
}

/** Missing declared fields are unavailable, while wrong types and undeclared payloads are invalid inputs. */
export function assertAchievementObservationContract(observation: AchievementObservation, contract: AchievementObservationContract): void {
  if (!sameTopic(observation.topic, contract.topic)) throw new Error("观察主题与提供者声明不符");
  for (const [key, value] of Object.entries(observation.values)) {
    if (!Object.hasOwn(contract.values, key)) throw new Error(`观察值未在提供者契约声明：${key}`);
    const type = value === null ? "null" : typeof value;
    const declared = contract.values[key];
    if (typeof declared === "string" ? type !== declared : !declared.includes(type as "string" | "number" | "boolean" | "null")) throw new Error(`观察值类型与提供者契约不符：${key}`);
  }
  for (const key of Object.keys(observation.skillCards)) if (!contract.skillCollections.includes(key)) throw new Error(`技能集合未在提供者契约声明：${key}`);
}

