import { z } from "zod";
import { createDefaultSave } from "./boot";
import { PluginSettingsDataSchema } from "../content/packages/plugin-declarations";
import { CharacterDefeatRecordSchema, GameSettingsSchema, LONG_TERM_SAVE_FORMAT, LongTermSaveSchema, MatchHistoryRecordSchema, PlayerProfileSchema, SaveValidationError, TutorialProgressSchema, validateLongTermSave, type LongTermSave } from "./schema";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Reads recognizable saves field by field. Strict validation remains mandatory for all writes. */
export function recoverLongTermSave(input: unknown): LongTermSave {
  const valid = LongTermSaveSchema.safeParse(input);
  if (valid.success) return valid.data as LongTermSave;
  const raw = record(input);
  if (raw.format !== LONG_TERM_SAVE_FORMAT) throw new SaveValidationError("long-term", "Unrecognized long-term save format", input);
  const defaults = createDefaultSave();
  const issues = valid.error.issues.map(issue => `${issue.path.join(".") || "root"}: ${issue.message}`);
  function fields<S extends z.ZodRawShape>(schema: z.ZodObject<S>, value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
    const source = record(value);
    return Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => {
      const parsed = (field as z.ZodTypeAny).safeParse(source[key]);
      return [key, parsed.success ? parsed.data : fallback[key]];
    }));
  }
  function items<T>(schema: z.ZodType<T>, value: unknown): T[] {
    return Array.isArray(value) ? value.flatMap(item => { const parsed = schema.safeParse(item); return parsed.success ? [parsed.data] : []; }) : [];
  }
  const rawProfile = record(raw.profile);
  const profile = fields(PlayerProfileSchema, rawProfile, defaults.profile);
  profile.selectedSkillTags = [...new Set(items(z.enum(["gambler", "cheater", "intelligence-officer", "gunslinger"]), rawProfile.selectedSkillTags))].slice(0, 2);
  if (rawProfile.skillDeck !== undefined) {
    const deck = record(rawProfile.skillDeck);
    const carried = [...new Set(items(z.string().min(1), deck.carried))];
    profile.skillDeck = { carried, reserve: [...new Set(items(z.string().min(1), deck.reserve))].filter(id => !carried.includes(id)) };
  }
  const rawSettings = record(raw.settings);
  const settings = fields(GameSettingsSchema, rawSettings, defaults.settings);
  if (rawSettings.pluginSettings !== undefined) {
    // A damaged field in one plugin must not hide another plugin's settings.
    settings.pluginSettings = Object.fromEntries(Object.entries(record(rawSettings.pluginSettings)).flatMap(([id, value]) => {
      const stored = record(value);
      const values = Object.fromEntries(Object.entries(record(stored.values)).filter(([, v]) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))));
      const parsed = PluginSettingsDataSchema.safeParse({ [id]: { version: stored.version, values } });
      return parsed.success ? [[id, parsed.data[id]]] : [];
    }));
  }
  const progress = record(raw.tutorialProgress);
  const completedIds = [...new Set(items(z.string().min(1).max(128), progress.completedIds))];
  const defeats = items(CharacterDefeatRecordSchema.strip(), raw.defeats).filter((entry, index, all) => all.findIndex(other => other.opponentId === entry.opponentId) === index);
  const base = fields(LongTermSaveSchema, raw, defaults);
  return validateLongTermSave({
    ...base, schemaVersion: defaults.schemaVersion, profile, settings,
    tutorialProgress: TutorialProgressSchema.parse({ completedIds }),
    history: items(MatchHistoryRecordSchema.strip(), raw.history), defeats,
    // Keep the exact parsed input, including unknown plugin data and any older recovery records.
    recovery: { originals: [input], issues }
  });
}
