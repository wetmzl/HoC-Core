import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DesktopCoreUpdater, assertUpdateUrl, replaceAppImage } from './core-update.mjs';
import { newestRelease, desktopRelease, compareVersions, RELEASES_URL, WEB_RELEASES_URL, webReleaseIndex, webReleasePage, releaseChecksums } from './update-release.mjs';
import { PAGES_ORIGIN } from './update-chunks.mjs';

const payload = Buffer.from('neutral native updater fixture');
const sha256 = createHash('sha256').update(payload).digest('hex');
function release(version = '1.0.0', { platform = 'win', arch = 'x64', format = 'exe', prerelease = version.includes('-') } = {}) {
  const name = `HoC-Core-${version}-${platform}-${arch}.${format}`;
  return { tag_name: `v${version}`, draft: false, prerelease, body: '更新说明', assets: [{ name, state: 'uploaded',
    browser_download_url: `https://github.com/wetmzl/HoC-Core/releases/download/v${version}/${name}`, size: payload.length, digest: `sha256:${sha256}` }] };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hoc-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], opened = [], revealed = [], restarted = [];
  let metadata = release(), status = 200, download = payload;
  const updater = new DesktopCoreUpdater({ directory, version: '0.2.0-beta2', supported: true, platform: 'win32', arch: 'x64',
    openPath: async path => { opened.push(path); return ''; }, showItemInFolder: path => revealed.push(path), restart: path => restarted.push(path),
    fetchImpl: async address => {
      calls.push(address);
      return address.startsWith(RELEASES_URL) ? new Response(JSON.stringify(metadata), { status }) : new Response(download);
    }, ...options });
  const legacyTransport = updater.fetchImpl;
  updater.fetchImpl = (address, options) => address.startsWith(PAGES_ORIGIN) ? Promise.resolve(new Response('', { status: 503 })) : legacyTransport(address, options);
  return { updater, directory, calls, opened, revealed, restarted,
    metadata: value => { metadata = value; }, status: value => { status = value; }, download: value => { download = value; } };
}

test('release notes use a fixed anonymous feed, enforce size limits and reject unsafe redirects', async t => {
  const calls = [];
  let response = () => new Response('<feed>真实日志</feed>');
  const { updater } = await fixture(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); } });
  assert.deepEqual(await updater.releaseNotes(), { feed: '<feed>真实日志</feed>' });
  assert.equal(calls[0].url, 'https://github.com/wetmzl/HoC-Core/releases.atom');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(new Headers(calls[0].options.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[0].options.headers).has('Cookie'), false);
  response = () => new Response('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(updater.releaseNotes(), /日志过大/);
  response = () => new Response(null, { status: 302, headers: { location: 'https://example.com/feed' } });
  await assert.rejects(updater.releaseNotes(), /不受信任/);
  response = () => new Response('', { status: 503 });
  await assert.rejects(updater.releaseNotes(), /无法读取/);
});

test('channels sort SemVer, ignore drafts and never substitute a prerelease for stable', () => {
  const candidates = [release('1.0.0-beta.10'), release('0.9.0'), release('1.0.0-beta.2'), { ...release('2.0.0'), draft: true }];
  assert.equal(newestRelease(candidates, 'stable').tag_name, 'v0.9.0');
  assert.equal(newestRelease(candidates, 'latest').tag_name, 'v1.0.0-beta.10');
  assert.equal(newestRelease([release('1.0.0-beta2')], 'stable'), undefined);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.10'), 1);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.0-beta2', '2.0.0-beta1'), 1);
});
test('selects exact platform assets including historical AppImage x86_64 and rejects unsafe metadata', () => {
  assert.equal(desktopRelease(release('1.0.0', { platform: 'linux', arch: 'x86_64', format: 'AppImage' }), { platform: 'linux', arch: 'x64', appImage: '/app' }).format, 'AppImage');
  assert.throws(() => desktopRelease(release(), { platform: 'darwin', arch: 'arm64' }), /尚未提供/);
  const data = release(); data.assets[0].browser_download_url = 'https://example.com/update.exe';
  assert.throws(() => desktopRelease(data, { platform: 'win32', arch: 'x64' }), /地址/);
  data.assets[0].browser_download_url = release().assets[0].browser_download_url; data.assets[0].digest = null;
  assert.throws(() => desktopRelease(data, { platform: 'win32', arch: 'x64' }), /校验/);
  data.assets = [release().assets[0], release().assets[0]];
  assert.throws(() => desktopRelease(data, { platform: 'win32', arch: 'x64' }), /重复/);
});
test('stable 404 leaves the current version without querying the prerelease list', async t => {
  const f = await fixture(t); f.status(404);
  assert.deepEqual(await f.updater.check(), { state: 'no-release' });
  assert.deepEqual(f.calls, [`${RELEASES_URL}/latest`]);
});
test('latest includes prereleases and selects by version across pages', async t => {
  const pages = Array.from({ length: 100 }, () => release('0.1.0'));
  const f = await fixture(t, { fetchImpl: async address => new Response(JSON.stringify(address.endsWith('page=1') ? pages : [release('1.0.0-beta.3')])) });
  const result = await f.updater.check({ channel: 'latest' });
  assert.equal(result.release.version, '1.0.0-beta.3');
  assert.equal(result.release.prerelease, true);
});
test('never downgrades or queries releases for development apps', async t => {
  const f = await fixture(t); f.metadata(release('0.1.0'));
  assert.equal((await f.updater.check()).state, 'current');
  f.updater.supported = false;
  await assert.rejects(() => f.updater.check(), /开发模式/);
  assert.equal(f.calls.length, 1);
});
test('failed website fallback and unsupported channels are actionable', async t => {
  const f = await fixture(t); f.status(429);
  await assert.rejects(() => f.updater.check(), /稳定版网页信息无效/);
  await assert.rejects(() => f.updater.check({ channel: 'nightly' }), /通道/);
});

function webIndex(tags, page = 1) {
  const route = { repository: { ownerLogin: 'wetmzl', name: 'HoC-Core' }, page, toc: tags.map(tag => ({ anchorId: `release-${tag}` })) };
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { releasesIndexRoute: route } })}</script>`;
}
function webPage(tag, prerelease = false) {
  return `${prerelease ? '<span class="Label Label--warning">Pre-release</span>' : ''}<div data-test-selector="body-content"><p>网页更新说明 &amp; 验证</p><div>第二段</div><script>unsafe()</script><a href="/wetmzl/HoC-Core/releases/tag/v999.0.0">正文里的伪版本链接</a></div><include-fragment src="${WEB_RELEASES_URL}/expanded_assets/${tag}"></include-fragment>`;
}
async function websiteFixture(t, { platform = 'win32', arch = 'x64', format, prerelease = true, tag = 'v1.0.0-beta.10', ...options } = {}) {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform];
  const extension = format ?? ({ win32: 'exe', darwin: 'dmg', linux: 'tar.gz' })[platform];
  const name = `HoC-Core-${tag.slice(1)}-${os}-${arch}.${extension}`;
  const calls = [];
  let sums = `${sha256}  ${name}\n`, length = payload.length, contents = payload, api = 403;
  const transport = async (url, request) => {
    calls.push({ url, ...request });
    if (url.startsWith(RELEASES_URL)) {
      if (api === 'network') throw new TypeError('network unavailable');
      return new Response('{}', { status: api });
    }
    if (url === `${WEB_RELEASES_URL}/latest`) return new Response(null, { status: 302, headers: { location: `${WEB_RELEASES_URL}/tag/${tag}` } });
    if (url === `${WEB_RELEASES_URL}?page=1`) return new Response(webIndex(['v1.0.0-beta.2', 'v0.1.0'], 1));
    if (url === `${WEB_RELEASES_URL}?page=2`) return new Response(webIndex([tag], 2));
    if (url === `${WEB_RELEASES_URL}?page=3`) return new Response(webIndex([], 3));
    if (url === `${WEB_RELEASES_URL}/tag/${tag}`) return new Response(webPage(tag, prerelease));
    if (url.endsWith('/SHA256SUMS')) return new Response(sums);
    if (url === `${WEB_RELEASES_URL}/download/${tag}/${name}`)
      return request.method === 'HEAD' ? new Response(null, { headers: { 'content-length': String(length) } }) : new Response(contents);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const f = await fixture(t, { platform, arch, fetchImpl: transport, ...options });
  return { ...f, calls, name, transport, sums: value => { sums = value; }, length: value => { length = value; }, contents: value => { contents = value; }, api: value => { api = value; } };
}

for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
  test(`API-free ${platform}/${arch} check, verified download, receipt and installation`, async t => {
    const f = await websiteFixture(t, { platform, arch });
    const result = await f.updater.check({ channel: 'latest' });
    assert.equal(result.state, 'available'); assert.equal(result.release.tag, 'v1.0.0-beta.10');
    assert.match(result.release.notes, /网页更新说明 & 验证/); assert.doesNotMatch(result.release.notes, /unsafe\(\)/);
    assert.equal(result.release.sha256, sha256); assert.equal(result.release.bytes, payload.length);
    assert.ok(f.calls.some(call => call.method === 'HEAD'));
    assert.ok(f.calls.every(call => call.credentials === 'omit' && !new Headers(call.headers).has('Authorization') && !new Headers(call.headers).has('Cookie')));
    await f.updater.download({ channel: 'latest', tag: result.release.tag });
    assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready.sha256, sha256);
    assert.equal((await f.updater.getStatus({ channel: 'stable' })).ready, undefined);
    assert.equal((await f.updater.install({ channel: 'latest' })).state, platform === 'linux' ? 'manual' : 'installer');
    assert.equal(f.calls.filter(call => call.url.startsWith(RELEASES_URL)).length, 1);
  });
}

test('website fallback preserves stable, confirms genuine prerelease flags and never downgrades', async t => {
  const stable = await websiteFixture(t, { prerelease: false, tag: 'v1.0.0' });
  assert.equal((await stable.updater.check()).state, 'available');
  stable.updater.version = '2.0.0';
  assert.equal((await stable.updater.check()).state, 'current');
  const flagged = await websiteFixture(t, { prerelease: true, tag: 'v1.0.0' });
  await assert.rejects(flagged.updater.check(), /稳定版网页信息无效/);
  assert.equal((await flagged.updater.check({ channel: 'latest' })).release.prerelease, true);
  const noStable = await fixture(t, { fetchImpl: async url => url.startsWith(RELEASES_URL) ? new Response('', { status: 403 })
    : url.endsWith('/latest') ? new Response(null, { status: 302, headers: { location: WEB_RELEASES_URL } }) : new Response('public releases') });
  assert.deepEqual(await noStable.updater.check(), { state: 'no-release' });
});

test('API transport failures and 5xx use the website, but invalid API metadata never bypasses validation', async t => {
  const f = await websiteFixture(t);
  for (const status of ['network', 429, 503]) { f.api(status); assert.equal((await f.updater.check({ channel: 'latest' })).state, 'available'); }
  const invalid = await fixture(t); invalid.metadata({ ...release(), assets: [] });
  await assert.rejects(invalid.updater.check(), /安装包/);
  assert.ok(invalid.calls.every(url => url.startsWith(RELEASES_URL)));
});

test('fallback rejects missing, malformed or conflicting checksums, invalid size and corrupted downloads', async t => {
  const f = await websiteFixture(t);
  for (const sums of ['', `bad  ${f.name}\n`, `${sha256}  ${f.name}\n${sha256}  ${f.name}\n`, `${sha256}  ../${f.name}\n`]) {
    f.sums(sums); await assert.rejects(f.updater.check({ channel: 'latest' }), /校验/);
  }
  f.sums(`${sha256}  ${f.name}\n`);
  for (const size of [0, -1, 1024 * 1024 * 1024 + 1, NaN]) { f.length(size); await assert.rejects(f.updater.check({ channel: 'latest' }), /大小/); }
  f.length(payload.length); await f.updater.check({ channel: 'latest' }); f.contents(Buffer.alloc(payload.length, 0));
  await assert.rejects(f.updater.download({ channel: 'latest', tag: 'v1.0.0-beta.10' }), /校验失败/);
  assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready, undefined);
});

test('website parser refuses unknown layouts, foreign repositories, wrong pages and truncated pagination', async t => {
  assert.throws(() => webReleaseIndex('<html>changed</html>', 1), /格式已变化/);
  assert.throws(() => webReleaseIndex(webIndex([], 2), 1), /无效/);
  assert.throws(() => webReleaseIndex(webIndex([], 1).replace('wetmzl', 'someone'), 1), /无效/);
  assert.throws(() => webReleasePage(webPage('v1.0.0'), 'v2.0.0'), /无效/);
  assert.equal(releaseChecksums(`${sha256} *file.zip`).get('file.zip'), sha256);
  const f = await fixture(t, { fetchImpl: async url => url.startsWith(RELEASES_URL) ? new Response('', { status: 403 })
    : new Response(webIndex(['v1.0.0'], Number(new URL(url).searchParams.get('page')))) });
  await assert.rejects(f.updater.check({ channel: 'latest' }), /列表过长/);
});
test('downloads verify bytes and persist a reusable receipt; native installer only runs on request', async t => {
  const f = await fixture(t);
  await f.updater.check(); await f.updater.download({ tag: 'v1.0.0' });
  assert.equal(f.opened.length, 0);
  assert.equal((await f.updater.getStatus()).ready.sha256, sha256);
  assert.equal((await f.updater.install()).state, 'installer');
  assert.equal(f.opened.length, 1);
  assert.deepEqual(await readFile(f.opened[0]), payload);
  const restored = new DesktopCoreUpdater({ ...f.updater, candidate: undefined });
  assert.equal((await restored.getStatus()).ready.version, '1.0.0');
});
test('switching back to stable excludes an already downloaded prerelease', async t => {
  const f = await fixture(t); f.metadata([release('1.0.0-beta.1')]);
  await f.updater.check({ channel: 'latest' }); await f.updater.download({ tag: 'v1.0.0-beta.1', channel: 'latest' });
  assert.equal((await f.updater.getStatus()).ready, undefined);
  await assert.rejects(() => f.updater.install(), /没有可安装/);
  assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready.version, '1.0.0-beta.1');
});
test('corruption, truncation, oversize and cancellation never prepare an installable update', async t => {
  for (const data of [payload.subarray(0, 3), Buffer.alloc(payload.length), Buffer.concat([payload, payload])]) {
    const f = await fixture(t); f.download(data);
    await f.updater.check(); await assert.rejects(() => f.updater.download({ tag: 'v1.0.0' }), /校验|不完整|超出/);
    assert.equal((await f.updater.getStatus()).ready, undefined);
    await assert.rejects(stat(join(f.directory, 'download.part')), { code: 'ENOENT' });
  }
  const f = await fixture(t); f.updater.onProgress = () => f.updater.cancel();
  await f.updater.check(); await assert.rejects(() => f.updater.download({ tag: 'v1.0.0' }), /取消/);
  assert.equal((await f.updater.getStatus()).ready, undefined);
});
test('rechecks the downloaded file immediately before installation', async t => {
  const f = await fixture(t); await f.updater.check(); await f.updater.download({ tag: 'v1.0.0' });
  const path = join(f.directory, (await f.updater.getStatus()).ready.name);
  await writeFile(path, Buffer.alloc(payload.length));
  await assert.rejects(() => f.updater.install(), /损坏/);
  assert.deepEqual(f.opened, []);
});
test('archives open the download folder and macOS opens the installation image with explicit instructions', async t => {
  const zip = await fixture(t); zip.metadata(release('1.0.0', { format: 'zip' }));
  await zip.updater.check(); await zip.updater.download({ tag: 'v1.0.0' });
  assert.equal((await zip.updater.install()).state, 'manual'); assert.equal(zip.revealed.length, 1);
  const mac = await fixture(t, { platform: 'darwin', arch: 'arm64' }); mac.metadata(release('1.0.0', { platform: 'mac', arch: 'arm64', format: 'dmg' }));
  await mac.updater.check(); await mac.updater.download({ tag: 'v1.0.0' });
  assert.match((await mac.updater.install()).message, /拖入/); assert.equal(mac.opened.length, 1);
});
test('AppImage replacement is atomic, retains mode and player files, then requests restart', async t => {
  const f = await fixture(t, { platform: 'linux' });
  f.updater.appImage = join(f.directory, 'current.AppImage');
  await writeFile(f.updater.appImage, 'old executable', { mode: 0o755 });
  await writeFile(join(f.directory, 'player-save.json'), 'player data');
  f.metadata(release('1.0.0', { platform: 'linux', arch: 'x86_64', format: 'AppImage' }));
  await f.updater.check(); await f.updater.download({ tag: 'v1.0.0' });
  assert.equal((await f.updater.install()).state, 'restart');
  assert.deepEqual(await readFile(f.updater.appImage), payload);
  if (process.platform !== 'win32') assert.ok((await stat(f.updater.appImage)).mode & 0o100);
  assert.equal(await readFile(join(f.directory, 'player-save.json'), 'utf8'), 'player data');
  assert.deepEqual(f.restarted, [f.updater.appImage]);
});
test('AppImage replacement failures leave the existing executable intact and reject symlinks', async t => {
  const f = await fixture(t), source = join(f.directory, 'new'), destination = join(f.directory, 'old');
  await writeFile(source, payload); await writeFile(destination, 'old');
  await assert.rejects(() => replaceAppImage(source, destination, '0'.repeat(64)), /校验/);
  assert.equal(await readFile(destination, 'utf8'), 'old');
  await symlink(destination, join(f.directory, 'linked'));
  await assert.rejects(() => replaceAppImage(source, join(f.directory, 'linked'), sha256), /自动替换/);
});
test('rejects untrusted URLs including credential injection and redirected downloads', async t => {
  for (const address of ['http://github.com/a', 'https://example.com/a', 'https://github.com@evil.test/a', 'https://github.com:444/a']) {
    assert.throws(() => assertUpdateUrl(address, false), /不受信任/);
  }
  const f = await fixture(t, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/update' } }) });
  await assert.rejects(() => f.updater.check(), /不受信任/);
});
