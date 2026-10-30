/** Authored by the outer flow; the table renderer never chooses a game mode. */
export interface EncounterTablePresentation {
  readonly titleSuffix: string;
  readonly exit?: { readonly label: string; readonly title: string };
}
