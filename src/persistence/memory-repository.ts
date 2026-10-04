import { validateLongTermSave, validateRuntimeSave, type LongTermSave, type RuntimeSave } from "./schema";
import type { SaveRepository } from "./repository";

function copyLongTerm(save: LongTermSave): LongTermSave { return validateLongTermSave(JSON.parse(JSON.stringify(save)) as unknown); }
function copyRuntime(save: RuntimeSave): RuntimeSave { return validateRuntimeSave(JSON.parse(JSON.stringify(save)) as unknown); }

/** In-memory implementation used by tests and lightweight host integrations. */
export class MemorySaveRepository implements SaveRepository {
  private longTerm: LongTermSave | null;
  private runtime: RuntimeSave | null;
  readonly longTermWrites: LongTermSave[] = [];
  readonly runtimeWrites: RuntimeSave[] = [];
  readonly commits: LongTermSave[] = [];

  constructor(initial: { readonly longTerm?: LongTermSave | null; readonly runtime?: RuntimeSave | null } = {}) {
    this.longTerm = initial.longTerm ? copyLongTerm(initial.longTerm) : null;
    this.runtime = initial.runtime ? copyRuntime(initial.runtime) : null;
  }

  async loadLongTerm(): Promise<LongTermSave | null> { return this.longTerm ? copyLongTerm(this.longTerm) : null; }

  async saveLongTerm(save: LongTermSave): Promise<void> {
    const valid = copyLongTerm(save);
    this.longTerm = valid;
    this.longTermWrites.push(copyLongTerm(valid));
  }

  async deleteLongTerm(): Promise<void> { this.longTerm = null; }

  async loadRuntime(): Promise<RuntimeSave | null> { return this.runtime ? copyRuntime(this.runtime) : null; }

  async saveRuntime(save: RuntimeSave): Promise<void> {
    const valid = copyRuntime(save);
    this.runtime = valid;
    this.runtimeWrites.push(copyRuntime(valid));
  }

  async deleteRuntime(): Promise<void> { this.runtime = null; }

  async commitMatchResult(save: LongTermSave): Promise<void> {
    const valid = copyLongTerm(save);
    this.longTerm = valid;
    this.runtime = null;
    this.longTermWrites.push(copyLongTerm(valid));
    this.commits.push(copyLongTerm(valid));
  }

  async closeGameRuntime(save: LongTermSave): Promise<void> {
    const valid = copyLongTerm(save);
    this.longTerm = valid;
    this.runtime = null;
    this.longTermWrites.push(copyLongTerm(valid));
  }
}
