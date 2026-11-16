import type { CharacterDefinition } from "./content/characters/types";

export type NotebookEndingId = "playerVictory" | "playerDefeat" | "escaped";
export interface NotebookPortrait { readonly image: string; readonly label: string; }
export interface NotebookEnding {
  readonly id: NotebookEndingId;
  readonly label: string;
  readonly unlocked: boolean;
  readonly text?: string;
  readonly image?: string;
}

/** The archive lists authored lines; it never evaluates or fabricates live dialogue conditions. */
export function notebookDialogueLines(character: CharacterDefinition): readonly string[] {
  return [...new Set(Object.values(character.dialogue.pools).flat().filter(line => line.trim().length > 0))];
}

/** Table expressions and package-provided dialogue overrides, excluding profile covers. */
export function notebookPortraits(character: CharacterDefinition): readonly NotebookPortrait[] {
  const entries: NotebookPortrait[] = [];
  const seen = new Set<string>();
  const add = (image: string | undefined, label?: string) => {
    if (!image || seen.has(image)) return;
    seen.add(image);
    entries.push({ image, label: label ?? `立绘 ${entries.length + 1}` });
  };
  for (const [key, label] of [["relaxed", "常态"], ["conflicted", "困扰"], ["mocking", "得意"], ["threatened", "紧张"], ["unconscious", "落败"]] as const) add(character.assets[key], label);
  for (const portrait of character.tablePortrait?.images ?? []) add(portrait.image);
  for (const portrait of Object.values(character.dialogue.poolPortraits ?? {})) add(portrait.image);
  for (const rule of character.dialogue.rules) add(rule.portrait?.image);
  return entries;
}

/** Locked endings carry neither prose nor an image URL, including in the DOM projection. */
export function notebookEndings(character: CharacterDefinition, unlocked: readonly NotebookEndingId[]): readonly NotebookEnding[] {
  const definitions = [
    { id: "playerVictory" as const, label: "策展人胜利", image: character.assets.defeatedSummary ?? character.assets.unconscious },
    { id: "playerDefeat" as const, label: "策展人落败", image: character.assets.relaxed },
    { id: "escaped" as const, label: "策展人离席", image: character.assets.conflicted }
  ];
  return definitions.map(ending => unlocked.includes(ending.id)
    ? { ...ending, unlocked: true, text: character.matchSummary[ending.id] }
    : { id: ending.id, label: ending.label, unlocked: false });
}
