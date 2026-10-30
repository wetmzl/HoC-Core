import type { AbilityDefinition } from "./types";

/** Lv1 is the base definition. Unsupported levels never silently fall back. */
export function resolveAbilityLevel(definition: AbilityDefinition, level = 1): AbilityDefinition {
  if (!Number.isSafeInteger(level) || level < 1) throw new Error(`Invalid ability level: ${level}`);
  if (level === 1) return definition;
  const variant = definition.levels?.find(entry => entry.level === level);
  if (!variant) throw new Error(`Unknown level ${level} for ability ${definition.id}`);
  const { level: _level, ...overrides } = variant;
  return Object.freeze({ ...definition, ...overrides });
}
