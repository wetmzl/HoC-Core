import { SeededRng } from "../core/rng/seeded";
import { previewPendingTrigger } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { anchorIndex, matchesTest } from "./facts";
import { FirstMatchIndex, IntervalWinners, isNumericTest } from "./intervals";
import { activeDialogueRegistry } from "./registry";
import { activeDialogueEvents, extractDialogueEvents } from "./events";
import type { CharacterDialogue, DialogueAtom, DialogueCondition, DialogueDiagnostic, DialogueEvent, DialoguePrimitiveContext, DialogueScalar, DialogueSelection } from "./types";

const unavailable = Symbol("unavailable");
type Value = DialogueScalar | typeof unavailable;
const stable = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
function atoms(c: DialogueCondition): DialogueAtom[] { return "primitive" in c ? [c] : "not" in c ? atoms(c.not) : ("all" in c ? c.all : c.any).flatMap(atoms); }
function guard(c: DialogueCondition): string | undefined {
  if ("primitive" in c) return c.primitive === "core.phase" && "eq" in c.test && typeof c.test.eq === "string" ? c.test.eq : undefined;
  return "all" in c ? c.all.map(guard).find(v => v !== undefined) : undefined;
}
export function frozenSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown) => { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}
interface Group { indices: number[]; atom: DialogueAtom; table: IntervalWinners }
interface Bucket { rules: number[]; groups: Group[] }

/** Event-scoped query cache. Rendering only peeks the committed selection. */
export class DialogueEngine {
  private revision = -1;
  private readonly buckets = new Map<string, Bucket>();
  private readonly disabled = new Set<number>();
  private readonly reported = new Set<string>();
  private readonly values = new Map<string, Value>();
  private readonly matches: FirstMatchIndex;
  private activeGroups: Group[] = [];
  private readonly matched = new Set<number>();
  private mark(index: number, value: boolean) { this.matches.set(index, value); if (value) this.matched.add(index); else this.matched.delete(index); }
  private context?: DialoguePrimitiveContext;
  private previous?: MatchState;
  private event?: DialogueEvent;
  private selection?: DialogueSelection;
  private readonly seen = new Set<string>();
  readonly diagnostics: DialogueDiagnostic[] = [];
  constructor(readonly program: CharacterDialogue, readonly characterId: string, readonly registry = activeDialogueRegistry(), readonly events = activeDialogueEvents()) { this.matches = new FirstMatchIndex(program.rules.length); }
  private queryKey(a: DialogueAtom): string { return stable([a.primitive, a.apiVersion, a.args]); }
  private report(index: number, reason: string, primitive?: string): void {
    const ruleId = this.program.rules[index].id, key = `${ruleId}:${primitive ?? ""}:${reason}`;
    if (this.reported.has(key)) return;
    this.reported.add(key); const diagnostic = { characterId: this.characterId, ruleId, primitive, reason }; this.diagnostics.push(diagnostic);
    console.warn("角色对白规则不可用", diagnostic);
  }
  private compile(): void {
    this.buckets.clear(); this.reported.clear(); this.diagnostics.length = 0;
    const candidates = new Map<string, Map<string, Group>>();
    this.program.rules.forEach((rule, i) => {
      if (rule.portrait?.image === "about:invalid#dialogue-portrait") { this.disabled.add(i); this.report(i, "portrait-unavailable"); }
      const simple = "all" in rule.when ? rule.when.all : [rule.when];
      const ranges = simple.filter((c): c is DialogueAtom => "primitive" in c && isNumericTest(c.test));
      const numeric = ranges.length === 1 && simple.every(c => "primitive" in c && (c === ranges[0] || c.primitive === "core.phase" && "eq" in c.test && typeof c.test.eq === "string" && c.test.eq === guard(rule.when)));
      for (const on of rule.on) {
        const key = `${on.type}@${on.apiVersion}:${guard(rule.when) ?? "*"}`;
        const bucket = this.buckets.get(key) ?? { rules: [], groups: [] }; this.buckets.set(key, bucket);
        if (!numeric) { bucket.rules.push(i); continue; }
        const groups = candidates.get(key) ?? new Map<string, Group>(); candidates.set(key, groups);
        const q = this.queryKey(ranges[0]); const group = groups.get(q) ?? { indices: [], atom: ranges[0], table: new IntervalWinners([]) };
        group.indices.push(i); groups.set(q, group);
      }
    });
    for (const [key, groups] of candidates) for (const group of groups.values()) { group.table = this.intervalTable(group); this.buckets.get(key)!.groups.push(group); }
    this.revision = this.registry.revision;
  }
  private usable(index: number): boolean {
    if (this.disabled.has(index)) return false;
    for (const a of atoms(this.program.rules[index].when)) {
      if (!this.registry.get(a.primitive, a.apiVersion) || !this.registry.validateArgs(a.primitive, a.apiVersion, a.args)) { this.report(index, "primitive-missing-version-or-arguments", a.primitive); return false; }
    }
    return true;
  }
  private intervalTable(group: Group): IntervalWinners {
    return new IntervalWinners(group.indices.filter(i => this.usable(i)).map(index => ({ index, test: atoms(this.program.rules[index].when).find(a => isNumericTest(a.test))!.test })));
  }
  private read(a: DialogueAtom, index: number): Value {
    const key = this.queryKey(a); if (this.values.has(key)) return this.values.get(key)!;
    let value: Value = unavailable, reason: string | undefined;
    const p = this.registry.get(a.primitive, a.apiVersion);
    if (!p || !this.registry.validateArgs(a.primitive, a.apiVersion, a.args)) reason = "primitive-missing-version-or-arguments";
    else try {
      this.registry.evaluating++;
      const v = p.read(this.context!, frozenSnapshot(a.args));
      if (v !== undefined && (v === null || typeof v === p.returnType) && (typeof v !== "number" || Number.isFinite(v))) value = v;
      else reason = "primitive-unavailable-or-invalid-result";
    } catch { reason = "primitive-threw"; }
    finally { this.registry.evaluating--; }
    this.values.set(key, value); if (reason) this.report(index, reason, a.primitive); return value;
  }
  private evaluate(c: DialogueCondition, index: number): boolean | typeof unavailable {
    if ("primitive" in c) { const v = this.read(c, index); return v === unavailable ? unavailable : matchesTest(v, c.test); }
    if ("not" in c) { const v = this.evaluate(c.not, index); return v === unavailable ? unavailable : !v; }
    const children = ("all" in c ? c.all : c.any).map(child => this.evaluate(child, index));
    if (children.includes(unavailable)) return unavailable;
    return "all" in c ? children.every(Boolean) : children.some(Boolean);
  }
  /** Only an explicitly delivered event can sample facts. Duplicate identities are ignored. */
  accept(state: MatchState, event: DialogueEvent, presentation: Readonly<Record<string, unknown>> = {}): DialogueSelection {
    if (this.seen.has(event.id)) return this.peek(state);
    this.events.validate(event);
    if (this.revision !== this.registry.revision) this.compile();
    this.seen.add(event.id); this.event = frozenSnapshot(event); this.previous = state; this.values.clear();
    const snapshot = frozenSnapshot(state);
    let pending: DialoguePrimitiveContext["pendingTrigger"], previewed = false;
    const context = { state: snapshot, event: this.event, characterId: this.characterId, presentation: frozenSnapshot(presentation) };
    Object.defineProperty(context, "pendingTrigger", { enumerable: true, get: () => {
      if (!previewed) { previewed = true; const p = previewPendingTrigger(state); if (p) pending = Object.freeze({ actor: p.actor, cancelled: p.cancelled, baseProbability: p.baseProbability, probability: p.probability }); }
      return pending;
    } });
    this.context = Object.freeze(context);
    for (const index of this.matched) this.matches.set(index, false); this.matched.clear(); this.activeGroups = [];
    for (const phase of ["*", state.round.phase]) {
      const bucket = this.buckets.get(`${event.type}@${event.apiVersion}:${phase}`);
      if (!bucket) continue;
      for (const i of bucket.rules) if (this.usable(i)) this.mark(i, this.evaluate(this.program.rules[i].when, i) === true);
      for (const g of bucket.groups) { this.activeGroups.push(g); this.matchGroup(g); }
    }
    return this.choose();
  }
  private matchGroup(g: Group) {
    const value = this.read(g.atom, g.indices[0]); const index = typeof value === "number" ? g.table.select(value) : undefined;
    if (index !== undefined) this.mark(index, true);
  }
  private choose(): DialogueSelection {
    const index = this.matches.first();
    if (index === undefined) return this.peek(this.previous!);
    const rule = this.program.rules[index], state = this.previous!;
    const source = rule.anchor && rule.anchor !== "dialogue-event" ? `${state.round.phase}:${anchorIndex(state, rule.anchor)}` : this.event!.id;
    const key = `${source}:${rule.id}:${rule.poolId}`;
    const lines = this.program.pools[rule.poolId];
    return { ruleId: rule.id, poolId: rule.poolId, key, line: lines[SeededRng.fromSnapshot(state.rng.dialogue).derive(key).nextInt(lines.length)], portrait: rule.portrait };
  }
  peek(state: MatchState): DialogueSelection {
    if (!this.selection) {
      const poolId = this.program.fallbackPoolId, lines = this.program.pools[poolId], key = `${state.id}:fallback:${poolId}`;
      this.selection = { ruleId: null, poolId, key, line: lines[SeededRng.fromSnapshot(state.rng.dialogue).derive(key).nextInt(lines.length)] };
    }
    return this.selection;
  }
  invalidateCapabilities() { this.revision = -1; this.values.clear(); this.context = undefined; this.reported.clear(); this.diagnostics.length = 0; }
  commit(selection: DialogueSelection) { this.selection = selection; }
  rejectPortrait(ruleId: string): DialogueSelection {
    const index = this.program.rules.findIndex(r => r.id === ruleId);
    if (index >= 0) { if (this.selection?.ruleId === ruleId) this.selection = undefined; this.disabled.add(index); this.mark(index, false); this.report(index, "portrait-unavailable");
      for (const group of this.activeGroups) if (group.indices.includes(index)) { group.table = this.intervalTable(group); this.matchGroup(group); }
    }
    return this.choose();
  }
  /** Convenience for DOM-free consumers: infer normal events from history, never from numbers. */
  select(state: MatchState): DialogueSelection {
    const events = extractDialogueEvents(this.previous, state); this.previous = state;
    for (const event of events) this.commit(this.accept(state, event));
    return this.peek(state);
  }
}
const engines = new WeakMap<CharacterDialogue, WeakMap<object, DialogueEngine>>();
export function dialogueEngine(program: CharacterDialogue, characterId = "character", registry = activeDialogueRegistry()): DialogueEngine {
  let byRegistry = engines.get(program); if (!byRegistry) { byRegistry = new WeakMap(); engines.set(program, byRegistry); }
  let engine = byRegistry.get(registry); if (!engine) { engine = new DialogueEngine(program, characterId, registry); byRegistry.set(registry, engine); } return engine;
}
