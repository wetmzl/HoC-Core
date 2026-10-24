import { matchesTest } from "./facts";
import type { DialogueTest } from "./types";

/** A min segment tree: ordered selection never walks every rule. */
export class FirstMatchIndex {
  private readonly size: number;
  private readonly tree: Float64Array;
  constructor(count: number) { this.size = 2 ** Math.ceil(Math.log2(Math.max(1, count))); this.tree = new Float64Array(this.size * 2).fill(Infinity); }
  set(index: number, matches: boolean): void { let node = this.size + index; this.tree[node] = matches ? index : Infinity; while ((node >>= 1) > 0) this.tree[node] = Math.min(this.tree[node * 2], this.tree[node * 2 + 1]); }
  first(): number | undefined { return Number.isFinite(this.tree[1]) ? this.tree[1] : undefined; }
}
interface IntervalEntry { readonly index: number; readonly test: DialogueTest }
/** Sweep finite boundaries once, recording both singleton points and open spans. */
export class IntervalWinners {
  private readonly boundaries: number[];
  private readonly points: (number | undefined)[] = [];
  private readonly spans: (number | undefined)[] = [];
  private readonly globalIndices: number[];
  constructor(entries: readonly IntervalEntry[]) {
    entries = [...entries].sort((a, b) => a.index - b.index);
    this.globalIndices = entries.map(e => e.index);
    const events = new Map<number, { startClosed: number[]; startOpen: number[]; endClosed: number[]; endOpen: number[] }>();
    const index = new FirstMatchIndex(entries.length);
    const at = (x: number) => { let e = events.get(x); if (!e) { e = { startClosed: [], startOpen: [], endClosed: [], endOpen: [] }; events.set(x, e); } return e; };
    for (const [localIndex, entry] of entries.entries()) {
      const r = "eq" in entry.test ? { min: entry.test.eq as number, max: entry.test.eq as number } : entry.test.range;
      if (r.min === undefined) index.set(localIndex, true);
      else at(r.min)[r.minInclusive === false ? "startOpen" : "startClosed"].push(localIndex);
      if (r.max !== undefined) at(r.max)[r.maxInclusive === false ? "endOpen" : "endClosed"].push(localIndex);
    }
    this.boundaries = [...events.keys()].sort((a, b) => a - b);
    this.spans.push(index.first());
    for (const x of this.boundaries) {
      const e = events.get(x)!;
      e.startClosed.forEach(i => index.set(i, true)); e.endOpen.forEach(i => index.set(i, false));
      this.points.push(index.first());
      e.endClosed.forEach(i => index.set(i, false)); e.startOpen.forEach(i => index.set(i, true));
      this.spans.push(index.first());
    }
  }
  select(value: number): number | undefined {
    let lo = 0, hi = this.boundaries.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.boundaries[mid] < value) lo = mid + 1; else hi = mid; }
    const local = this.boundaries[lo] === value ? this.points[lo] : this.spans[lo];
    return local === undefined ? undefined : this.globalIndices[local];
  }
}
export function isNumericTest(test: DialogueTest): boolean { return "range" in test || typeof test.eq === "number"; }
export { matchesTest };
