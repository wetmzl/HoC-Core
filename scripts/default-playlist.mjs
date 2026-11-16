/** The standard playlist shipped alongside the embedded content directory. */
export function createEmbeddedDefaultPlaylist(index, manifests) {
  const entries = index.packages ?? [];
  const ids = new Set(entries.map(entry => entry.packageId));
  const defaults = index.defaultEnabled ?? [...ids];
  if (new Set(defaults).size !== defaults.length || defaults.some(id => !ids.has(id))) throw new Error('Default playlist contains unknown or duplicate embedded packages');
  const selected = new Set(defaults);
  const packages = entries.filter(entry => selected.has(entry.packageId)).map(entry => ({ packageId: entry.packageId, ...(entry.version ? { version: entry.version } : {}) }));
  const byId = new Map(manifests.map(manifest => [`${manifest.identity.authorId}/${manifest.identity.packageName}`, manifest]));
  const pluginOrder = packages.filter(entry => {
    const manifest = byId.get(entry.packageId);
    if (!manifest) throw new Error(`Default playlist manifest is missing: ${entry.packageId}`);
    return manifest.resources.some(resource => resource.type === 'plugin.module');
  }).map(entry => entry.packageId);
  return { format: 'house-of-chances-playlist', formatVersion: 2, name: '官方播放集', packages, pluginOrder };
}
