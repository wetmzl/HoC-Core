import type { PresentationDeclaration } from "../content/packages/plugin-declarations";
export type { PresentationDeclaration } from "../content/packages/plugin-declarations";
import Dexie, { type Table } from "dexie";
import { Capacitor } from "@capacitor/core";
import { CapacitorFileSaveStorageDriver } from "./capacitor-driver";
import { assertAuthoringValue } from "../content/packages/authoring-schema";
import { frozenSnapshot } from "../dialogue/engine";

export interface PresentationDriver { read(): Promise<Record<string, unknown>>; write(records: Record<string, unknown>): Promise<void> }
export class MemoryPresentationDriver implements PresentationDriver {
  records: Record<string, unknown> = {};
  async read() { return structuredClone(this.records); }
  async write(records: Record<string, unknown>) { this.records = structuredClone(records); }
}
export class BrowserPresentationDriver implements PresentationDriver {
  private readonly db: Dexie;
  private readonly records: Table<{ id: string; data: unknown }, string>;
  constructor(name = "house-of-chances-presentation") { this.db = new Dexie(name); this.db.version(1).stores({ records: "id" }); this.records = this.db.table("records"); }
  async read() { return Object.fromEntries((await this.records.toArray()).map(r => [r.id, r.data])); }
  async write(records: Record<string, unknown>) { await this.db.transaction("rw", this.records, async () => { await this.records.clear(); await this.records.bulkPut(Object.entries(records).map(([id, data]) => ({ id, data }))); }); }
}
export class NativePresentationDriver implements PresentationDriver {
  constructor(private readonly driver = new CapacitorFileSaveStorageDriver(undefined, undefined, "presentation", true)) {}
  async read() { const s = await this.driver.readSnapshot(); return (s?.longTerm ?? {}) as Record<string, unknown>; }
  async write(records: Record<string, unknown>) { await this.driver.writeSnapshot({ longTerm: records, runtime: null }); }
}

export class PresentationStore {
  private records: Record<string, unknown> = {};
  private queue = Promise.resolve();
  private loaded?: Promise<void>;
  constructor(readonly driver: PresentationDriver) {}
  async load() { this.loaded ??= this.driver.read().then(v => { if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("表现记录索引无效"); this.records = v; }).catch(error => { console.warn("表现存储不可读取，已重置", error); this.records = {}; }); await this.loaded; }
  key(matchId: string, packageId: string) { return JSON.stringify([matchId, packageId]); }
  get(matchId: string, packageId: string, declaration: PresentationDeclaration): unknown {
    const id = this.key(matchId, packageId), stored = this.records[id] as { apiVersion?: number; state?: unknown; sequence?: number } | undefined;
    try { if (stored) { if (stored.apiVersion !== declaration.apiVersion || !Number.isSafeInteger(stored.sequence) || stored.sequence! < 0) throw Error("版本或序号无效"); assertAuthoringValue(declaration.schema, stored.state); return frozenSnapshot(stored.state); } }
    catch (error) { console.warn("插件表现记录损坏，已重置", { matchId, packageId, error }); delete this.records[id]; }
    return frozenSnapshot(declaration.initial);
  }
  set(matchId: string, packageId: string, declaration: PresentationDeclaration, state: unknown) {
    assertAuthoringValue(declaration.schema, state);
    const id = this.key(matchId, packageId), previous = this.records[id] as { sequence?: number } | undefined;
    this.records[id] = { apiVersion: declaration.apiVersion, state: structuredClone(state), sequence: previous?.sequence ?? 0 }; this.save();
  }
  nextSequence(matchId: string, packageId: string, declaration: PresentationDeclaration): number {
    const id = this.key(matchId, packageId);
    if (!this.records[id]) this.set(matchId, packageId, declaration, declaration.initial);
    const record = this.records[id] as { sequence: number }; record.sequence++; this.save(); return record.sequence;
  }
  clearAll() { this.records = {}; this.save(); }
  clearMatch(matchId: string) { for (const id of Object.keys(this.records)) if (JSON.parse(id)[0] === matchId) delete this.records[id]; this.save(); }
  private save() { const records = structuredClone(this.records); this.queue = this.queue.then(() => this.driver.write(records)).catch(error => console.warn("表现记录保存失败", error)); }
  flush() { return this.queue; }
}
let active: PresentationStore | undefined;
export function presentationStore() { return active ??= new PresentationStore(Capacitor.isNativePlatform() ? new NativePresentationDriver() : new BrowserPresentationDriver()); }
