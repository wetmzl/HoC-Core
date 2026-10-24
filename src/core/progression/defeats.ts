/** A durable first-defeat fact, independent from the disposable match log. */
export interface CharacterDefeatRecord {
  readonly opponentId: string;
  readonly timestamp: string;
}

/** Adds a character only once so later rematches cannot replace the acquisition time. */
export function addFirstCharacterDefeat(
  defeats: readonly CharacterDefeatRecord[],
  opponentId: string,
  timestamp: string
): readonly CharacterDefeatRecord[] {
  if (defeats.some((record) => record.opponentId === opponentId)) return defeats;
  return [...defeats, { opponentId, timestamp }];
}
