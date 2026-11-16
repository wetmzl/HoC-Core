import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DesktopCoreUpdater } from './core-update.mjs';
import { PAGES_ORIGIN, parseChunks } from './update-chunks.mjs';
import { RELEASES_URL } from './update-release.mjs';

const payload = Buffer.from('neutral persistent updater content');
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { platform = 'win32', arch = 'x64', format, appImage } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hoc-pages-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '1.0.0-beta.2', tag = `v${version}`;
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform];
  const name = `HoC-Core-${version}-${os}-${arch}.${format ?? { win32: 'exe', darwin: 'dmg', linux: 'tar.gz' }[platform]}`;
  const url = `https://github.com/wetmzl/HoC-Core/releases/download/${tag}/${name}`;
  const manifestUrl = `${PAGES_ORIGIN}/files/${tag}/${name}.json`;
  const asset = { name, state: 'uploaded', size: payload.length, digest: `sha256:${sha(payload)}`, browser_download_url: url, chunk_manifest_url: manifestUrl };
  const release = { tag_name: tag, name: '中性更新', draft: false, prerelease: true, body: '完整更新日志', assets: [asset] };
  const parts = [payload.subarray(0, 10), payload.subarray(10)];
  const manifest = { schemaVersion: 1, name, bytes: payload.length, sha256: sha(payload), sourceUrl: url,
    parts: parts.map((data, index) => ({ index, offset: index === 0 ? 0 : 10, bytes: data.length, sha256: sha(data), url: `${PAGES_ORIGIN}/assets/chunks/${sha(data)}.part` })) };
  const calls = []; let channelStatus = 200, document = { schemaVersion: 1, channel: 'latest', release },
    descriptor = manifest, corrupt = -1, unavailable = -1, badRange = false;
  const options = { directory, version: '0.2.0-beta2', supported: true, platform, arch, appImage, openPath: async () => '', showItemInFolder() {}, restart() {},
    fetchImpl: async (address, options) => {
      calls.push({ address, ...options });
      if (address === `${PAGES_ORIGIN}/channels/latest.json`) return new Response(JSON.stringify(document), { status: channelStatus });
      if (address === manifestUrl) return new Response(JSON.stringify(descriptor));
      for (const [index, part] of manifest.parts.entries()) if (address === part.url)
        return new Response(index === corrupt ? Buffer.alloc(part.bytes) : parts[index], { status: index === unavailable ? 503 : 200 });
      if (address === url) {
        const range = options.headers.Range;
        if (!range) return new Response(payload);
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
        return new Response(payload.subarray(Number(start), Number(end) + 1), { status: 206, headers: { 'content-range': badRange ? 'bytes 0-0/1' : `bytes ${start}-${end}/${payload.length}` } });
      }
      if (address.startsWith(RELEASES_URL)) return new Response(JSON.stringify([release]));
      throw new Error(`Unexpected request ${address}`);
    } };
  return { directory, options, updater: new DesktopCoreUpdater(options), calls, release, asset, manifest, parts, url, name,
    document: value => { document = value; }, status: value => { channelStatus = value; }, descriptor: value => { descriptor = value; },
    corrupt: value => { corrupt = value; }, unavailable: value => { unavailable = value; }, badRange: () => { badRange = true; } };
}
async function download(f) { const result = await f.updater.check({ channel: 'latest' }); return f.updater.download({ channel: 'latest', tag: result.release.tag }); }

test('Pages JSON contains authoritative no-release and current results without consulting GitHub', async t => {
  const f = await fixture(t); f.document({ schemaVersion: 1, channel: 'latest', release: null });
  assert.equal((await f.updater.check({ channel: 'latest' })).state, 'no-release');
  f.document({ schemaVersion: 1, channel: 'latest', release: f.release }); f.updater.version = '2.0.0';
  assert.equal((await f.updater.check({ channel: 'latest' })).state, 'current');
  assert.ok(f.calls.every(call => call.address.startsWith(PAGES_ORIGIN)));
});
for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
  test(`Pages ${platform}/${arch} downloads and verifies selected platform chunks`, async t => {
    const f = await fixture(t, { platform, arch }); await download(f);
    assert.deepEqual(await readFile(join(f.directory, f.name)), payload);
    assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready.sha256, sha(payload));
    assert.ok(f.calls.every(call => call.address.startsWith(PAGES_ORIGIN)));
    assert.ok(f.calls.every(call => call.credentials === 'omit'));
  });
}
test('cancellation retains fsynced parts and a new updater instance resumes without fetching them again', async t => {
  const f = await fixture(t), partPath = join(f.directory, 'chunks', sha(payload), `${sha(f.parts[0])}.part`);
  f.updater.onProgress = () => { if (existsSync(partPath)) f.updater.cancel(); };
  await assert.rejects(download(f), /取消/);
  assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready, undefined);
  assert.equal(existsSync(partPath), true);
  f.calls.length = 0; f.updater = new DesktopCoreUpdater(f.options); await download(f);
  assert.equal(f.calls.filter(call => call.address === f.manifest.parts[0].url).length, 0);
  assert.equal(f.calls.filter(call => call.address === f.manifest.parts[1].url).length, 1);
  assert.deepEqual(await readFile(join(f.directory, f.name)), payload);
});
test('a corrupted local part is fetched again while valid parts are reused', async t => {
  const f = await fixture(t); await download(f);
  await rm(join(f.directory, f.name)); await rm(join(f.directory, 'ready.json'));
  await writeFile(join(f.directory, 'chunks', sha(payload), `${sha(f.parts[1])}.part`), Buffer.alloc(f.parts[1].length));
  f.calls.length = 0; await download(f);
  assert.equal(f.calls.filter(call => call.address === f.manifest.parts[0].url).length, 0);
  assert.equal(f.calls.filter(call => call.address === f.manifest.parts[1].url).length, 1);
});
test('remote hash failures never fall back to GitHub, and retry keeps other valid parts', async t => {
  const f = await fixture(t); f.corrupt(1);
  await assert.rejects(download(f), /校验失败/);
  assert.equal(f.calls.filter(call => call.address.startsWith('https://github.com')).length, 0);
  assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready, undefined);
  f.corrupt(-1); f.calls.length = 0; f.updater = new DesktopCoreUpdater(f.options); await download(f);
  assert.equal(f.calls.filter(call => call.address === f.manifest.parts[0].url).length, 0);
});
test('Pages chunk availability failure uses the same GitHub asset range and validates its chunk hash', async t => {
  const f = await fixture(t); f.unavailable(1); await download(f);
  const fallback = f.calls.find(call => call.address === f.url);
  assert.equal(fallback.headers.Range, `bytes=10-${payload.length - 1}`);
  assert.ok(!f.calls.some(call => call.address.startsWith(RELEASES_URL)));
  assert.deepEqual(await readFile(join(f.directory, f.name)), payload);
});
test('invalid GitHub range identity is refused and cannot prepare installation', async t => {
  const f = await fixture(t); f.unavailable(1); f.badRange();
  await assert.rejects(download(f), /正确分段/);
  assert.equal((await f.updater.getStatus({ channel: 'latest' })).ready, undefined);
});
test('Pages channel outages permit GitHub discovery, while malformed metadata never does', async t => {
  const f = await fixture(t); f.status(503);
  assert.equal((await f.updater.check({ channel: 'latest' })).release.tag, f.release.tag_name);
  f.status(200); f.calls.length = 0; f.document({ schemaVersion: 2, channel: 'latest', release: f.release });
  await assert.rejects(f.updater.check({ channel: 'latest' }), /通道信息无效/);
  assert.ok(f.calls.every(call => call.address.startsWith(PAGES_ORIGIN)));
});
test('manifest filename, whole digest, offsets and addresses cannot change the selected identity', async t => {
  const f = await fixture(t);
  for (const mutate of [m => { m.sha256 = '0'.repeat(64); }, m => { m.parts[0].offset = 1; }, m => { m.parts[0].url = 'https://example.com/part'; }]) {
    const bad = structuredClone(f.manifest); mutate(bad); f.descriptor(bad);
    await assert.rejects(download(f), /不匹配|无效/);
  }
  assert.ok(!f.calls.some(call => call.address.startsWith('https://github.com')));
  assert.throws(() => parseChunks({ ...f.manifest, name: '../file.exe' }, { name: f.name }), /不匹配/);
});
test('same-version attachment hash conflicts retain the previous verified target and receipt', async t => {
  const f = await fixture(t); await download(f);
  const receipt = await readFile(join(f.directory, 'ready.json'));
  f.asset.digest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(download(f), /身份或摘要已变化/);
  assert.deepEqual(await readFile(join(f.directory, f.name)), payload);
  assert.deepEqual(await readFile(join(f.directory, 'ready.json')), receipt);
});
