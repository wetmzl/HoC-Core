export interface RawSaveSnapshot {
  readonly longTerm: unknown | null;
  readonly runtime: unknown | null;
  /** Independent additive record; old runtime and long-term schemas remain unchanged. */
  readonly story?: unknown | null;
  /** Permanent achievement checkpoint and live observation state, committed with gameplay. */
  readonly achievements?: unknown | null;
  /** Independent permanent character collection and individually observed endings. */
  readonly notebook?: unknown | null;
}

/** Platform storage boundary. Drivers persist opaque values and never interpret game schemas. */
export interface SaveStorageDriver {
  readSnapshot(): Promise<RawSaveSnapshot | null>;
  /** Publishes all records as one snapshot; readers must never see a partial replacement. */
  writeSnapshot(snapshot: RawSaveSnapshot): Promise<void>;
}

export function emptyRawSaveSnapshot(): RawSaveSnapshot {
  return { longTerm: null, runtime: null };
}
