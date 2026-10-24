import type { PluginCreditsDeclaration } from "./plugin-declarations";

export interface PluginCreditsSection {
  readonly packageId: string;
  readonly title: string;
  readonly paragraphs: PluginCreditsDeclaration["paragraphs"];
}

/** Only successfully registered modules enter this list; names and identities come from the host. */
export function collectPluginCredits(
  modules: readonly { readonly packageId: string; readonly title: string; readonly credits?: PluginCreditsDeclaration }[],
  order: readonly string[]
): readonly PluginCreditsSection[] {
  const sections = new Map<string, PluginCreditsSection>();
  for (const module of modules) {
    if (!module.credits) continue;
    let section = sections.get(module.packageId);
    if (!section) {
      section = { packageId: module.packageId, title: module.title, paragraphs: [] };
      sections.set(module.packageId, section);
    }
    section.paragraphs.push(...module.credits.paragraphs);
  }
  const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  return [...sections.values()].sort((a, b) => rank(a.packageId) - rank(b.packageId));
}
