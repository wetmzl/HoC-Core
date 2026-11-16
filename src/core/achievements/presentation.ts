import { ACHIEVEMENT_LIMITS, AchievementDefinitionSchema, AchievementKeySchema, AchievementLedgerSchema } from "./schema";
import type { AchievementDefinitionEntry, AchievementLedger, AchievementRecord } from "./types";

export interface AchievementPresentationEntry extends AchievementDefinitionEntry {
  readonly coverUrl?: string;
  readonly iconUrl?: string;
}
export type AchievementCover = { readonly type: "placeholder" } | { readonly type: "image"; readonly url: string };
export interface AchievementProgressPresentation {
  readonly metric: string;
  readonly target: number;
  /** Absent without a compatible active attempt; null means max has no sample. */
  readonly value?: number | null;
}
export interface HiddenAchievementPresentation {
  readonly status: "hidden";
  readonly name: "隐藏成就";
  readonly description: "解锁后显示具体内容。";
  readonly cover: { readonly type: "placeholder" };
}
interface VisibleMetadata {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly cover: AchievementCover;
}
export type VisibleAchievementPresentation = VisibleMetadata & (
  | { readonly status: "completed"; readonly completedAt: string }
  | { readonly status: "locked"; readonly progressDisplay?: AchievementProgressPresentation }
);
export type AchievementPresentation = HiddenAchievementPresentation | VisibleAchievementPresentation;
export interface AchievementListPresentation {
  readonly rows: readonly VisibleAchievementPresentation[];
  readonly hiddenCount: number;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkedEntry(entry: AchievementPresentationEntry): AchievementPresentationEntry {
  const key = AchievementKeySchema.parse(entry.key), definition = AchievementDefinitionSchema.parse(entry.definition);
  if (!key.endsWith(`/${definition.id}`)) throw new Error("成就全局 ID 与定义局部 ID 不一致");
  return { key, definition, coverUrl: entry.coverUrl, iconUrl: entry.iconUrl };
}

function progress(entry: AchievementPresentationEntry, ledger: AchievementLedger, record: AchievementRecord | undefined): AchievementProgressPresentation | undefined {
  const hint = entry.definition.progressDisplay;
  if (!hint) return undefined;
  const available = record && !record.suspended && !record.invalidated && record.revision === entry.definition.revision
    // Both inputs have been normalized by the same schema, including optional undefined fields.
    && JSON.stringify(record.tracking) === JSON.stringify(entry.definition.tracking)
    && (record.tracking.scope === "profile" || ledger.windows[record.tracking.scope]?.status === "active"
      && ledger.windows[record.tracking.scope]?.id === record.scopeId);
  const metric = available ? record.metrics[hint.metric] : undefined;
  return { ...hint, ...(metric ? { value: metric.type === "distinct" ? metric.values.length : metric.value } : {}) };
}

function project(entry: AchievementPresentationEntry, committedLedger: AchievementLedger): AchievementPresentation {
  const { definition } = entry;
  const record = Object.hasOwn(committedLedger.records, entry.key) ? committedLedger.records[entry.key] : undefined;
  if (definition.hidden && !record?.completed) {
    return freeze({ status: "hidden", name: "隐藏成就", description: "解锁后显示具体内容。", cover: { type: "placeholder" } } as const);
  }
  const url = definition.cover && entry.coverUrl || definition.icon && entry.iconUrl;
  const metadata: VisibleMetadata = {
    key: entry.key, name: definition.name, description: definition.description,
    ...(definition.category ? { category: definition.category } : {}),
    cover: url ? { type: "image", url } : { type: "placeholder" }
  };
  if (record?.completed) return freeze({ ...metadata, status: "completed", completedAt: record.completed.at } as const);
  const hint = progress(entry, committedLedger, record);
  return freeze({ ...metadata, status: "locked", ...(hint ? { progressDisplay: hint } : {}) } as const);
}

/** The host supplies its committed ledger, never the speculative completion notification array. */
export function projectAchievement(entry: AchievementPresentationEntry, committedLedger: AchievementLedger): AchievementPresentation {
  return project(checkedEntry(entry), AchievementLedgerSchema.parse(committedLedger));
}

/** Hidden locked definitions contribute only to the count, keeping their identities out of serialized rows. */
export function projectAchievementList(entries: readonly AchievementPresentationEntry[], committedLedger: AchievementLedger): AchievementListPresentation {
  if (entries.length > ACHIEVEMENT_LIMITS.records) throw new Error("成就目录数量超过预算");
  const ledger = AchievementLedgerSchema.parse(committedLedger);
  const checked = entries.map(checkedEntry);
  if (new Set(checked.map(entry => entry.key)).size !== checked.length) throw new Error("成就全局 ID 重复");
  const rows: VisibleAchievementPresentation[] = [];
  let hiddenCount = 0;
  for (const entry of checked) {
    const presentation = project(entry, ledger);
    if (presentation.status === "hidden") hiddenCount++;
    else rows.push(presentation);
  }
  return freeze({ rows, hiddenCount });
}
