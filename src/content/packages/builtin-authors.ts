/** Canonical package owner; source artwork attribution remains in license notices. */
export const CORE_PACKAGE_AUTHOR_ID = "hoc-core";
export const CORE_PACKAGE_AUTHOR_NAME = "HoC-core";

/** Published identities remain accepted when migrating repositories and playlists. */
export const LEGACY_BUILTIN_PACKAGE_IDS: Readonly<Record<string, string>> = Object.freeze({
  "hoc-art/chatgpt": "hoc-core/chatgpt",
  "hoc-art/claude": "hoc-core/claude",
  "hoc-art/gemini": "hoc-core/gemini",
  "hoc-art/deepseek": "hoc-core/deepseek",
  "hoc-art/llama": "hoc-core/llama",
  "commuity/official-built-in-skills": "hoc-core/official-built-in-skills",
  "commuity/official-built-in-talents": "hoc-core/official-built-in-talents"
});

export function canonicalBuiltinPackageId(packageId: string): string {
  return LEGACY_BUILTIN_PACKAGE_IDS[packageId] ?? packageId;
}
