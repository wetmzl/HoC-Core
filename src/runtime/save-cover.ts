export interface SaveCoverSelection {
  readonly loadFeatureCandidates?: () => Promise<readonly string[]>;
  readonly baseCandidates: readonly string[];
  readonly isAvailable: (url: string) => Promise<boolean>;
}

/** Selects a cover without making an optional feature a prerequisite for save export. */
export async function selectSaveCoverImage(options: SaveCoverSelection): Promise<string> {
  let featureCandidates: readonly string[] = [];
  try { featureCandidates = await options.loadFeatureCandidates?.() ?? []; }
  catch { /* Optional feature failures fall through to character base art. */ }
  for (const url of new Set([...featureCandidates, ...options.baseCandidates])) {
    if (await options.isAvailable(url)) return url;
  }
  throw new Error("存档封面资源不可用。");
}
