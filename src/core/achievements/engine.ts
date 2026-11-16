import { evaluateAchievementCondition, evaluateAchievementNumber, evaluateAchievementValue } from "./evaluation";
import { ACHIEVEMENT_LIMITS, AchievementDefinitionSchema, AchievementKeySchema, AchievementLedgerSchema, AchievementObservationContractSchema, AchievementObservationSchema } from "./schema";
import type { AchievementDefinition, AchievementDefinitionEntry, AchievementDiagnostic, AchievementEvaluation, AchievementLedger, AchievementMetric, AchievementObservation, AchievementObservationContract, AchievementRecord, AchievementTracking, AchievementWindow, AchievementWindowScope } from "./types";
import { assertAchievementObservationContract, validateAchievementInputs } from "./validation";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Property order is presentation; array order remains part of the declared rule. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function initialMetrics(tracking: AchievementTracking): Record<string, AchievementMetric> {
  return Object.fromEntries(tracking.tracks.map((track): [string, AchievementMetric] => [track.id, track.progress.type === "distinct"
    ? { type: "distinct", values: [] } : track.progress.type === "max" ? { type: "max", value: null }
      : { type: track.progress.type, value: 0 }]));
}

function freshRecord(definition: AchievementDefinition, scopeId: string): AchievementRecord {
  return { revision: definition.revision, tracking: definition.tracking, scopeId, metrics: initialMetrics(definition.tracking), invalidated: false, suspended: false };
}

function topicKey(topic: AchievementObservation["topic"]): string {
  return JSON.stringify([topic.type, topic.apiVersion]);
}

/** A new stream starts at sequence zero. Storage and production scheduling belong to its caller. */
export function createAchievementLedger(streamId: string): AchievementLedger {
  return freeze(AchievementLedgerSchema.parse({ schemaVersion: 1, streamId, nextSequence: 0, windows: {}, records: {} }));
}

function reset(record: AchievementRecord): AchievementRecord {
  return { ...record, metrics: initialMetrics(record.tracking), invalidated: false };
}

function active(record: AchievementRecord, windows: AchievementLedger["windows"]): boolean {
  const scope = record.tracking.scope;
  return scope === "profile" || windows[scope]?.status === "active" && windows[scope]?.id === record.scopeId;
}

function begins(scope: AchievementWindowScope, observation: AchievementObservation): boolean {
  return observation.boundary?.phase === "begin" && observation.boundary.scope === scope;
}

/** A live attempt owns its tracking snapshot until its explicit closing boundary. */
function reconcile(record: AchievementRecord | undefined, definition: AchievementDefinition, observation: AchievementObservation, windows: AchievementLedger["windows"]): AchievementRecord | undefined {
  if (record?.completed) return { ...record, suspended: false };
  if (record && !record.suspended && record.tracking.scope !== "profile" && !begins(record.tracking.scope, observation) && active(record, windows)) return record;
  if (definition.tracking.scope === "profile") {
    if (!record || record.revision !== definition.revision || record.tracking.scope !== "profile"
      || record.suspended && definition.tracking.continuity === "continuous") return freshRecord(definition, observation.streamId);
    return { ...record, suspended: false };
  }
  if (begins(definition.tracking.scope, observation)) return freshRecord(definition, observation.scopes[definition.tracking.scope]!);
  // A definition returning mid-window cannot establish that it observed the whole attempt.
  return record ? { ...record, suspended: record.suspended || record.tracking.scope === "profile" } : undefined;
}

function checkedTotal(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error("成就统计溢出安全数值范围");
  return value;
}

function consumeRecord(key: string, input: AchievementRecord, observation: AchievementObservation, diagnostics: AchievementDiagnostic[]): AchievementRecord {
  let record = input;
  const tracking = record.tracking;
  if (record.completed || record.suspended || record.invalidated) return record;
  const messages = new Set<string>();
  const unavailable = (message: string) => {
    if (!messages.has(message)) diagnostics.push({ key, code: "input-unavailable", message });
    messages.add(message);
  };
  const context = () => ({ observation, metrics: record.metrics, onUnavailable: unavailable });
  const gap = () => tracking.continuity === "cumulative" ? record
    : tracking.scope === "profile" ? reset(record) : { ...record, invalidated: true };
  if (tracking.invalidateWhen) {
    const invalid = evaluateAchievementCondition(tracking.invalidateWhen, context());
    if (invalid === undefined) return gap();
    if (invalid) return { ...record, invalidated: true };
  }
  if (tracking.resetWhen) {
    const restart = evaluateAchievementCondition(tracking.resetWhen, context());
    if (restart === undefined) return gap();
    if (restart) record = reset(record);
  }
  let missing = false;
  const metrics: Record<string, AchievementMetric> = { ...record.metrics };
  for (const track of tracking.tracks) {
    if (track.on && !track.on.some(topic => topicKey(topic) === topicKey(observation.topic))) continue;
    if (track.when) {
      const matches = evaluateAchievementCondition(track.when, context());
      if (matches === undefined) { missing = true; continue; }
      if (!matches) continue;
    }
    const previous = metrics[track.id];
    const progress = track.progress;
    if (progress.type === "count" && previous.type === "count") {
      metrics[track.id] = { type: "count", value: checkedTotal(previous.value + 1) };
    } else if (progress.type === "distinct" && previous.type === "distinct") {
      const value = evaluateAchievementValue(progress.value, context());
      if (value === undefined) { missing = true; continue; }
      if (previous.values.length < progress.limit && !previous.values.includes(value)) metrics[track.id] = { type: "distinct", values: [...previous.values, value] };
    } else if ((progress.type === "sum" || progress.type === "max") && previous.type === progress.type) {
      const value = evaluateAchievementNumber(progress.value, context());
      if (value === undefined || value < 0 || !Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
        unavailable(`统计 ${track.id} 需要非负安全数值`);
        missing = true;
        continue;
      }
      metrics[track.id] = progress.type === "sum"
        ? { type: "sum", value: checkedTotal(previous.value! + value) }
        : { type: "max", value: checkedTotal(Math.max(previous.value ?? 0, value)) };
    }
  }
  record = { ...record, metrics };
  if (missing && tracking.continuity === "continuous") return gap();
  const boundary = observation.boundary;
  const completesNow = tracking.completion === "immediate" || boundary?.phase === "end"
    && boundary.reason === "completed" && boundary.scope === tracking.scope;
  if (!completesNow) return record;
  const completed = evaluateAchievementCondition(tracking.completeWhen, context());
  // An empty max metric or a temporarily unavailable completion snapshot is not an update gap.
  if (completed === undefined) return record;
  return completed ? { ...record, completed: { at: observation.at, sequence: observation.sequence, revision: record.revision } } : record;
}

/** Pure reducer over an explicitly ordered semantic stream; it never reads game state or performs IO. */
export function advanceAchievements(entries: readonly AchievementDefinitionEntry[], ledger: AchievementLedger, observation: AchievementObservation,
  contracts: readonly AchievementObservationContract[]): AchievementEvaluation {
  const previous = AchievementLedgerSchema.parse(ledger);
  const current = AchievementObservationSchema.parse(observation);
  if (entries.length > ACHIEVEMENT_LIMITS.records || contracts.length > ACHIEVEMENT_LIMITS.records) throw new Error("成就目录或观察契约数量超过预算");
  const definitions = entries.map(entry => ({ key: AchievementKeySchema.parse(entry.key), definition: AchievementDefinitionSchema.parse(entry.definition) }));
  if (definitions.some(entry => !entry.key.endsWith(`/${entry.definition.id}`))) throw new Error("成就全局 ID 与定义局部 ID 不一致");
  if (new Set(definitions.map(entry => entry.key)).size !== definitions.length) throw new Error("成就全局 ID 重复");
  const declared = contracts.map(contract => AchievementObservationContractSchema.parse(contract));
  const byTopic = new Map(declared.map(contract => [topicKey(contract.topic), contract]));
  if (byTopic.size !== declared.length) throw new Error("成就观察主题契约重复");
  if (current.streamId !== previous.streamId) throw new Error("成就观察不属于此持久流");
  if (current.sequence < previous.nextSequence) return Object.freeze({ ledger, completed: Object.freeze([]), diagnostics: Object.freeze([]), replayed: true });
  if (current.sequence > previous.nextSequence) throw new Error("成就观察序号不连续");
  const contract = byTopic.get(topicKey(current.topic));
  if (contract) assertAchievementObservationContract(current, contract);
  const windows: Partial<Record<AchievementWindowScope, AchievementWindow>> = { ...previous.windows };
  const boundary = current.boundary;
  if (boundary) {
    const id = current.scopes[boundary.scope]!;
    const existing = windows[boundary.scope];
    if (boundary.phase === "begin") {
      if (existing?.status === "active") throw new Error("成就窗口尚未结束，不能重复或替代开始");
      if (existing?.id === id) throw new Error("成就窗口实例 ID 不得重复使用");
      windows[boundary.scope] = { id, status: "active" };
    } else if (existing?.status !== "active" || existing.id !== id) throw new Error("成就结束边界与活动窗口不一致");
  }
  const diagnostics: AchievementDiagnostic[] = [];
  if (!contract) diagnostics.push({ code: "unsupported-topic", message: `未声明的观察主题 ${current.topic.type}@${current.topic.apiVersion}` });
  const records: Record<string, AchievementRecord> = { ...previous.records };
  const present = new Set(definitions.map(entry => entry.key));
  for (const [key, record] of Object.entries(records)) if (!present.has(key)) records[key] = { ...record, suspended: true };
  const completed: { key: string; completion: NonNullable<AchievementRecord["completed"]> }[] = [];
  for (const { key, definition } of definitions) {
    const old = records[key];
    if (old?.revision === definition.revision && canonical(old.tracking) !== canonical(definition.tracking)) {
      diagnostics.push({ key, code: "tracking-revision-mismatch", message: "相同修订包含不同成就规则，请更新修订号" });
      records[key] = { ...old, suspended: true };
      continue;
    }
    let record = reconcile(old, definition, current, windows);
    const effective = record && !record.suspended ? { ...definition, revision: record.revision, tracking: record.tracking } : definition;
    const invalid = validateAchievementInputs(effective, declared);
    if (invalid.length) {
      diagnostics.push(...invalid.map(item => ({ ...item, key })));
      if (record) records[key] = { ...record, suspended: true };
      continue;
    }
    if (!record) continue;
    if (boundary?.phase === "end" && boundary.reason !== "completed" && record.tracking.scope === boundary.scope
      && record.scopeId === current.scopes[boundary.scope] && !record.completed) record = { ...record, invalidated: true };
    const scope = record.tracking.scope;
    const matchesWindow = scope === "profile" || active(record, windows) && current.scopes[scope] === record.scopeId;
    // Eligibility belongs to the global envelope, including unsupported topic versions.
    if (matchesWindow && !record.completed && !record.suspended && !record.tracking.allowDebug && current.debugUsed) {
      record = record.tracking.scope !== "profile" ? { ...record, invalidated: true }
        : record.tracking.continuity === "continuous" ? reset(record) : record;
    } else if (contract && matchesWindow) record = consumeRecord(key, record, current, diagnostics);
    records[key] = record;
    if (!old?.completed && record.completed) completed.push({ key, completion: record.completed });
  }
  if (boundary?.phase === "end") windows[boundary.scope] = { id: current.scopes[boundary.scope]!, status: boundary.reason };
  const next = AchievementLedgerSchema.parse({ ...previous, nextSequence: checkedTotal(previous.nextSequence + 1), windows, records });
  return freeze({ ledger: next, completed, diagnostics, replayed: false });
}
