import { z } from "zod";
import {
  CharacterDefeatRecordSchema,
  CURRENT_LONG_TERM_SCHEMA_VERSION,
  GameSettingsSchema,
  LONG_TERM_SAVE_FORMAT,
  MatchHistoryRecordSchema,
  validateLongTermSave,
  type LongTermSave
} from "./schema";

type MigrationStep = (input: unknown) => unknown;

const LongTermSaveV8Schema = z.object({
  format: z.literal(LONG_TERM_SAVE_FORMAT),
  schemaVersion: z.literal(8),
  gameVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  profile: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    matchesPlayed: z.number().int().min(0),
    wins: z.number().int().min(0),
    talentIds: z.array(z.string().min(1))
  }).strict(),
  settings: GameSettingsSchema,
  skipTutorial: z.boolean(),
  history: z.array(MatchHistoryRecordSchema),
  defeats: z.array(CharacterDefeatRecordSchema)
}).strict();

const migrateV8ToV9: MigrationStep = (input) => {
  const legacy = LongTermSaveV8Schema.parse(input);
  const { talentIds: _obsoleteTalentIds, ...profile } = legacy.profile;
  return {
    ...legacy,
    schemaVersion: 9,
    profile: { ...profile, selectedSkillTags: [] },
    tutorialProgress: { completedIds: [] }
  };
};

/** Every breaking long-term schema bump must add its step here and keep the step implementation in this file. */
const LONG_TERM_MIGRATIONS: ReadonlyMap<number, MigrationStep> = new Map([
  [8, migrateV8ToV9]
]);

function schemaVersionOf(input: unknown): number | null {
  if (!input || typeof input !== "object") return null;
  const version = (input as { readonly schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

export function canMigrateLongTermSave(input: unknown): boolean {
  let migrated = input;
  let version = schemaVersionOf(migrated);
  const visited = new Set<number>();
  let steps = 0;
  while (version !== null && version < CURRENT_LONG_TERM_SCHEMA_VERSION && !visited.has(version)) {
    visited.add(version);
    const step = LONG_TERM_MIGRATIONS.get(version);
    if (!step) return false;
    try {
      migrated = step(migrated);
      version = schemaVersionOf(migrated);
      steps += 1;
    }
    catch { return false; }
  }
  if (steps === 0 || version !== CURRENT_LONG_TERM_SCHEMA_VERSION) return false;
  try { validateLongTermSave(migrated); return true; }
  catch { return false; }
}

export function migrateLongTermSave(input: unknown): LongTermSave {
  let migrated = input;
  let version = schemaVersionOf(migrated);
  const visited = new Set<number>();
  while (version !== null && version < CURRENT_LONG_TERM_SCHEMA_VERSION && !visited.has(version)) {
    visited.add(version);
    const step = LONG_TERM_MIGRATIONS.get(version);
    if (!step) break;
    migrated = step(migrated);
    version = schemaVersionOf(migrated);
  }
  if (version !== CURRENT_LONG_TERM_SCHEMA_VERSION) throw new Error("当前没有适用于这份长期存档的迁移路径。");
  return validateLongTermSave(migrated);
}
