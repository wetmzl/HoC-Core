export const REPOSITORY = 'wetmzl/HoC-Core';
export const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases`;
export const WEB_RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const VERSION = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function updateChannel(value = 'stable') {
  if (!['stable', 'latest'].includes(value)) throw new Error('更新通道无效。');
  return value;
}
export function isPrerelease(version) { return Boolean(VERSION.exec(version)?.[4]); }
export function compareVersions(left, right) {
  const a = VERSION.exec(left), b = VERSION.exec(right);
  if (!a || !b) throw new Error('版本格式无效。');
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(a[i]), y = BigInt(b[i]);
    if (x !== y) return x > y ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const aa = a[4].split('.'), bb = b[4].split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i], y = bb[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1; }
    else return xn !== yn ? xn ? -1 : 1 : x > y ? 1 : -1;
  }
  return 0;
}
export function eligible(release, channel) {
  return release && !release.draft && typeof release.tag_name === 'string' && VERSION.test(release.tag_name)
    && !release.tag_name.includes('+') && (channel === 'latest' || (!release.prerelease && !isPrerelease(release.tag_name)));
}
export function newestRelease(releases, channel) {
  updateChannel(channel);
  return releases.filter(release => eligible(release, channel))
    .reduce((best, next) => !best || compareVersions(next.tag_name, best.tag_name) > 0 ? next : best, undefined);
}
/** 只读取 GitHub 自己的目录数据，不从发布正文中的链接猜版本。 */
export function webReleaseIndex(html, page) {
  const scripts = [...html.matchAll(/<script\b(?=[^>]*\btype="application\/json")(?=[^>]*\bdata-target="react-app\.embeddedData")[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1) throw new Error('GitHub 网页发布目录格式已变化，请稍后重试。');
  const route = JSON.parse(scripts[0][1]).payload?.releasesIndexRoute;
  if (route?.repository?.ownerLogin !== 'wetmzl' || route.repository.name !== 'HoC-Core' || route.page !== page || !Array.isArray(route.toc))
    throw new Error('GitHub 网页发布目录无效。');
  return route.toc.map(item => ({ tag_name: typeof item.anchorId === 'string' && item.anchorId.startsWith('release-') ? item.anchorId.slice(8) : '' }));
}

export function webReleasePage(html, tag) {
  const marker = `src="${WEB_RELEASES_URL}/expanded_assets/${tag}"`;
  if (!html.includes(marker)) throw new Error('GitHub 网页发布信息无效。');
  const body = /<div\b[^>]*\bdata-test-selector="body-content"[^>]*>/i.exec(html);
  const header = body ? html.slice(0, body.index) : html;
  const prerelease = /<span\b[^>]*\bclass="[^"]*\bLabel--warning\b[^"]*"[^>]*>\s*Pre-release\s*<\/span>/i.test(header);
  let notes = '';
  if (body) {
    const start = body.index + body[0].length;
    const divs = /<\/?div\b[^>]*>/gi; divs.lastIndex = start;
    let depth = 1, end;
    for (let match; (match = divs.exec(html));) {
      depth += match[0].startsWith('</') ? -1 : 1;
      if (!depth) { end = match.index; break; }
    }
    if (end === undefined) throw new Error('GitHub 网页发布正文无效。');
    const text = html.slice(start, end).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?(?:p|div|h[1-6]|li|ul|ol|pre|blockquote)\b[^>]*>|<br\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '');
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    notes = text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? all;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    }).replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
  }
  return { tag_name: tag, prerelease, body: notes };
}

export function releaseChecksums(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || result.has(match[2])) throw new Error('发布校验清单格式无效或包含重复文件。');
    result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

export function desktopAssetNames(tag, { platform, arch, appImage }) {
  if (!VERSION.test(tag) || tag.includes('+')) throw new Error('版本格式无效。');
  const version = tag.replace(/^v/, '');
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error('此桌面平台暂不支持应用更新。');
  const formats = platform === 'win32' ? ['exe', 'zip'] : platform === 'darwin' ? ['dmg', 'zip'] : appImage ? ['AppImage'] : ['tar.gz'];
  return formats.flatMap(format => (format === 'AppImage' && arch === 'x64' ? ['x86_64', 'x64'] : [arch])
    .map(cpu => `HoC-Core-${version}-${os}-${cpu}.${format}`));
}
export function desktopRelease(release, { platform, arch, appImage }) {
  const version = release.tag_name.replace(/^v/, '');
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error('此桌面平台暂不支持应用更新。');
  // AppImage's ${arch} macro uses x86_64, while archive targets use x64.
  const formats = platform === 'win32' ? ['exe', 'zip'] : platform === 'darwin' ? ['dmg', 'zip'] : appImage ? ['AppImage'] : ['tar.gz'];
  for (const format of formats) {
    const arches = format === 'AppImage' && arch === 'x64' ? ['x86_64', 'x64'] : [arch];
    const names = arches.map(cpu => `HoC-Core-${version}-${os}-${cpu}.${format}`);
    const assets = release.assets?.filter(asset => names.includes(asset.name) && asset.state === 'uploaded') ?? [];
    if (assets.length > 1) throw new Error('发布包含重复安装包，请稍后重试。');
    if (!assets.length) continue;
    const asset = assets[0];
    if (asset.browser_download_url !== `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${asset.name}`
        || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)
        || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 * 1024 * 1024)
      throw new Error('发布安装包的地址、大小或校验信息无效。');
    return { version, tag: release.tag_name, notes: String(release.body ?? '').slice(0, 8000),
      prerelease: Boolean(release.prerelease || isPrerelease(version)), bytes: asset.size,
      sha256: asset.digest.slice(7).toLowerCase(), url: asset.browser_download_url, name: asset.name, format };
  }
  throw new Error('所选版本尚未提供当前平台和架构的安装包，请稍后重试。');
}
