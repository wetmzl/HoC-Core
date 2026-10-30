export interface RawSaveSnapshot {
  readonly longTerm: unknown | null;
  readonly runtime: unknown | null;
}

/** Platform storage boundary. Drivers persist opaque values and never interpret game schemas. */
export interface SaveStorageDriver {
  readSnapshot(): Promise<RawSaveSnapshot | null>;
  /** Publishes both records as one snapshot; readers must never see a partial replacement. */
  writeSnapshot(snapshot: RawSaveSnapshot): Promise<void>;
}

export function emptyRawSaveSnapshot(): RawSaveSnapshot {
  return { longTerm: null, runtime: null };
}
