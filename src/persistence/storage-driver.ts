export interface RawSaveSnapshot {
  readonly longTerm: unknown | null;
  readonly runtime: unknown | null;
}

/** Platform storage boundary. Drivers persist opaque values and never interpret game schemas. */
export interface SaveStorageDriver {
  readSnapshot(): Promise<RawSaveSnapshot | null>;
  writeSnapshot(snapshot: RawSaveSnapshot): Promise<void>;
}

export function emptyRawSaveSnapshot(): RawSaveSnapshot {
  return { longTerm: null, runtime: null };
}
