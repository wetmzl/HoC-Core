export const DEFAULT_SAVE_COVER_URL = "/assets/save-share-cover.png";

export interface SaveCoverSelection {
  readonly loadFeatureCandidates?: () => Promise<readonly string[]>;
  readonly isAvailable: (url: string) => Promise<boolean>;
}

/** Selects a cover without making an optional feature a prerequisite for save export. */
export async function selectSaveCoverImage(options: SaveCoverSelection): Promise<string> {
  let featureCandidates: readonly string[] = [];
  try { featureCandidates = await options.loadFeatureCandidates?.() ?? []; }
  catch { /* Optional feature failures fall through to the fixed public cover. */ }
  for (const url of new Set([...featureCandidates, DEFAULT_SAVE_COVER_URL])) {
    if (await options.isAvailable(url)) return url;
  }
  throw new Error("存档封面资源不可用。");
}
