import { validateLongTermSave, validateRuntimeSave, type LongTermSave, type RuntimeSave } from "./schema";
import type { SaveRepository, CheckpointSaveRepository, SaveCheckpointContext, SaveCheckpointProjector } from "./repository";
import type { RawSaveSnapshot } from "./storage-driver";
import { projectNotebookSnapshot } from "./character-records";

function copyLongTerm(save: LongTermSave): LongTermSave { return validateLongTermSave(JSON.parse(JSON.stringify(save)) as unknown); }
function copyRuntime(save: RuntimeSave): RuntimeSave { return validateRuntimeSave(JSON.parse(JSON.stringify(save)) as unknown); }

/** In-memory implementation used by tests and lightweight host integrations. */
export class MemorySaveRepository implements SaveRepository, CheckpointSaveRepository {
  private longTerm: LongTermSave | null;
  private runtime: RuntimeSave | null;
  private story: unknown | null | undefined;
  private achievements: unknown | null | undefined;
  private notebook: unknown | null | undefined;
  private readonly projectors = new Set<SaveCheckpointProjector>();
  private readonly listeners = new Set<(snapshot: RawSaveSnapshot) => void>();
  readonly longTermWrites: LongTermSave[] = [];
  readonly runtimeWrites: RuntimeSave[] = [];
  readonly commits: LongTermSave[] = [];

  constructor(initial: { readonly longTerm?: LongTermSave | null; readonly runtime?: RuntimeSave | null; readonly story?: unknown | null; readonly achievements?: unknown | null; readonly notebook?: unknown | null } = {}) {
    this.longTerm = initial.longTerm ? copyLongTerm(initial.longTerm) : null;
    this.runtime = initial.runtime ? copyRuntime(initial.runtime) : null;
    this.story = initial.story;
    this.notebook = initial.notebook === undefined ? undefined : structuredClone(initial.notebook);
    this.achievements = initial.achievements === undefined ? undefined : structuredClone(initial.achievements);
  }

  private snapshot(): RawSaveSnapshot { return { longTerm: this.longTerm, runtime: this.runtime,
    ...(this.story !== undefined ? { story: this.story } : {}), ...(this.achievements !== undefined ? { achievements: this.achievements } : {}), ...(this.notebook !== undefined ? { notebook: this.notebook } : {}) }; }
  async readSnapshot(): Promise<RawSaveSnapshot> { return JSON.parse(JSON.stringify(this.snapshot())) as RawSaveSnapshot; }
  addCheckpointProjector(projector: SaveCheckpointProjector): () => void { this.projectors.add(projector); return () => this.projectors.delete(projector); }
  subscribeCheckpoints(listener: (snapshot: RawSaveSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private checkpoint(proposed: RawSaveSnapshot, context: SaveCheckpointContext = {}): RawSaveSnapshot {
    let next = proposed;
    const previous = this.snapshot();
    for (const projector of this.projectors) next = projector(previous, next, context);
    next = projectNotebookSnapshot(previous, next, context);
    const longTerm = next.longTerm === null ? null : copyLongTerm(next.longTerm as LongTermSave);
    const runtime = next.runtime === null ? null : copyRuntime(next.runtime as RuntimeSave);
    const story = next.story === undefined ? undefined : JSON.parse(JSON.stringify(next.story));
    const achievements = next.achievements === undefined ? undefined : structuredClone(next.achievements);
    this.longTerm = longTerm; this.runtime = runtime; this.story = story; this.achievements = achievements;
    this.notebook = next.notebook === undefined ? undefined : structuredClone(next.notebook);
    for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Durable observers cannot undo a commit. */ } }
    return this.snapshot();
  }
  async projectSnapshot(project: (snapshot: RawSaveSnapshot) => RawSaveSnapshot, context?: SaveCheckpointContext): Promise<RawSaveSnapshot> {
    return this.checkpoint(project(this.snapshot()), context);
  }

  async loadLongTerm(): Promise<LongTermSave | null> { return this.longTerm ? copyLongTerm(this.longTerm) : null; }

  async saveLongTerm(save: LongTermSave): Promise<void> {
    const valid = copyLongTerm(save);
    this.checkpoint({ ...this.snapshot(), longTerm: valid });
    this.longTermWrites.push(copyLongTerm(valid));
  }

  async deleteLongTerm(): Promise<void> { this.checkpoint({ ...this.snapshot(), longTerm: null, ...(this.story !== undefined ? { story: null } : {}) }); }

  async loadRuntime(): Promise<RuntimeSave | null> { return this.runtime ? copyRuntime(this.runtime) : null; }

  async saveRuntime(save: RuntimeSave, context?: SaveCheckpointContext): Promise<void> {
    const valid = copyRuntime(save);
    this.checkpoint({ ...this.snapshot(), runtime: valid }, context);
    this.runtimeWrites.push(copyRuntime(valid));
  }

  async deleteRuntime(context?: SaveCheckpointContext): Promise<void> { this.checkpoint({ ...this.snapshot(), runtime: null }, context); }

  async commitMatchResult(save: LongTermSave, runtime: RuntimeSave | null = null, context?: SaveCheckpointContext): Promise<void> {
    const valid = copyLongTerm(save);
    const nextRuntime = runtime === null ? null : copyRuntime(runtime);
    this.checkpoint({ ...this.snapshot(), longTerm: valid, runtime: nextRuntime }, context);
    this.longTermWrites.push(copyLongTerm(valid));
    if (nextRuntime !== null) this.runtimeWrites.push(copyRuntime(nextRuntime));
    this.commits.push(copyLongTerm(valid));
  }

  async closeGameRuntime(save: LongTermSave, context?: SaveCheckpointContext): Promise<void> {
    const valid = copyLongTerm(save);
    this.checkpoint({ ...this.snapshot(), longTerm: valid, runtime: null }, context);
    this.longTermWrites.push(copyLongTerm(valid));
  }
}
