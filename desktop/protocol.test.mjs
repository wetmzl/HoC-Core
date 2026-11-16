import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_SECURITY_POLICY, createAssetHandler, isAppUrl, resolveAssetPath } from './protocol.mjs';

test('only the fixed app origin can resolve packaged files', () => {
  const root = join(tmpdir(), 'hoc-web');
  for (const value of [
    'https://app/index.html', 'file:///etc/passwd', 'hoc://evil/index.html',
    'hoc://app.evil/index.html', 'hoc://user@app/index.html', 'hoc://app:443/index.html',
    'hoc://app/%2e%2e%2fsecret', 'hoc://app/%2e%2e%5csecret',
    'hoc://app/file%00.js', 'hoc://app/file.txt%3asecret', 'hoc://app/%ZZ'
  ]) assert.equal(resolveAssetPath(root, value), null, value);
  assert.equal(isAppUrl('not a URL'), false);
  assert.equal(resolveAssetPath(root, 'hoc://app/?version=1'), join(root, 'index.html'));
});

test('serves exact binary bytes, MIME and CSP; blocks writes and missing files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hoc-electron-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 1, 128, 255]);
  await writeFile(join(root, 'sample.webp'), bytes);
  let reads = 0;
  const handle = createAssetHandler(root, async url => {
    reads++;
    return new Response(await readFile(fileURLToPath(url)));
  });
  const response = await handle(new Request('hoc://app/sample.webp'));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self' blob:/);
  assert.match(response.headers.get('Content-Security-Policy'), /object-src 'none'/);
  assert.equal((await handle(new Request('hoc://app/sample.webp', { method: 'HEAD' }))).body, null);
  assert.equal((await handle(new Request('hoc://app/missing.js'))).status, 404);
  assert.equal((await handle(new Request('hoc://app/sample.webp', { method: 'POST' }))).status, 405);
  assert.equal((await handle(new Request('hoc://evil/sample.webp'))).status, 403);
  assert.equal(reads, 3);
});


test('telemetry connects only to its two fixed receivers', () => {
  const connect = CONTENT_SECURITY_POLICY.split('; ').find(value => value.startsWith('connect-src '));
  assert.equal(connect, "connect-src 'self' blob: https://hoc-platform.house-of-chances.workers.dev/v1/events https://hoc-events.10170923.xyz/v1/events");
});
