import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildEmbeddedContent, buildPackageTree, imageBuildPlugin, imageOptions, rewriteImageText } from './image-build.mjs';

let root, sourceImage, sourceManifest;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'hoc-image-build-'));
  await mkdir(join(root, 'sample/assets'), { recursive: true });
  sourceImage = await sharp(Buffer.from([255, 0, 0, 255, 40, 170, 220, 123, 0, 0, 0, 0]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const files = {
    'assets/portrait.png': sourceImage,
    'cover.png': sourceImage,
    'match.json': Buffer.from(JSON.stringify({ definition: { assets: { cover: 'cover.png', relaxed: 'assets/portrait.png' }, tablePortrait: { anchorY: 1, images: [{ image: 'assets/portrait.png', anchorY: .9 }] } }, description: 'The file assets/portrait.png is a source.' })),
    'module.js': Buffer.from('resolvePluginAsset("assets/portrait.png"); const fallback = "/characters/sample/assets/portrait.png";'),
    'style.css': Buffer.from('.sample { background: url(assets/portrait.png) }')
  };
  const types = { png: 'image/png', json: 'application/json', js: 'text/javascript', css: 'text/css' };
  sourceManifest = {
    format: 'house-of-chances-hocpkg', formatVersion: 1,
    identity: { authorId: 'test', packageName: 'sample', version: '1.0.0' },
    metadata: { title: 'Sample', description: '', tags: [], creators: [] },
    resources: [{ id: 'match', type: 'game.character-match', apiVersion: 4, entry: 'match.json', requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({ path, mediaType: types[path.split('.').at(-1)], bytes: bytes.length, sha256: hash(bytes) })), extensions: {}
  };
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(root, 'sample', path), bytes);
  await writeFile(join(root, 'sample/hocpkg-info.json'), JSON.stringify(sourceManifest));
  await writeFile(join(root, 'packages.json'), JSON.stringify({ format: 'test-index', formatVersion: 2, packages: [{ packageId: 'test/sample', version: '1.0.0', manifest: 'sample/hocpkg-info.json' }] }));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('validates CLI/environment options and preserves Vite arguments', () => {
  assert.deepEqual(imageOptions([], {}), { mode: 'lossy', quality: 92, forwarded: [] });
  assert.deepEqual(imageOptions(['--images=lossless', '--quality', '80', '--config', 'extra.mjs'], { HOC_IMAGE_MODE: 'png' }), { mode: 'lossless', quality: 80, forwarded: ['--config', 'extra.mjs'] });
  for (const args of [['--images=jpeg'], ['--quality=101'], ['--quality=NaN'], ['--quality=-1'], ['--quality=0'], ['--images']]) assert.throws(() => imageOptions(args, {}));
});

for (const mode of ['lossy', 'lossless', 'png']) test(`${mode}: valid package references, dimensions, alpha, hashes and immutable originals`, async () => {
  const tree = await buildPackageTree(root, imageOptions(['--images', mode], {}));
  const pkg = tree.packages[0];
  const path = mode === 'png' ? 'assets/portrait.png' : 'assets/portrait.webp';
  const match = JSON.parse(pkg.files['match.json']);
  assert.equal(match.definition.assets.relaxed, path);
  assert.deepEqual(match.definition.tablePortrait, { anchorY: 1, images: [{ image: path, anchorY: .9 }] });
  const coverPath = mode === 'png' ? 'cover.png' : 'cover.webp';
  assert.equal(match.definition.assets.cover, coverPath);
  assert.equal(match.description, 'The file assets/portrait.png is a source.');
  assert.deepEqual(pkg.files[coverPath], pkg.files[path]);
  assert.equal(pkg.manifest.files.find(file => file.path === coverPath).mediaType, mode === 'png' ? 'image/png' : 'image/webp');
  assert.deepEqual(await readFile(join(root, 'sample/cover.png')), sourceImage);
  assert.equal(pkg.files['module.js'].toString(), `resolvePluginAsset("${path}"); const fallback = "/characters/sample/${path}";`);
  assert.ok(pkg.files['style.css'].toString().includes(`url(${path})`));
  const decoded = await sharp(pkg.files[path]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const original = await sharp(sourceImage).ensureAlpha().raw().toBuffer();
  assert.deepEqual([decoded.info.width, decoded.info.height], [3, 1]);
  for (let i = 0; i < original.length; i += 4) {
    assert.equal(decoded.data[i + 3], original[i + 3]);
    if (mode !== 'lossy' && original[i + 3]) assert.deepEqual(decoded.data.subarray(i, i + 4), original.subarray(i, i + 4));
  }
  if (mode === 'png') assert.deepEqual(pkg.files[path], sourceImage);
  for (const file of pkg.manifest.files) {
    assert.equal(pkg.files[file.path].length, file.bytes);
    assert.equal(hash(pkg.files[file.path]), file.sha256);
  }
  assert.equal(pkg.manifest.files.find(file => file.path === path).mediaType, mode === 'png' ? 'image/png' : 'image/webp');
  assert.deepEqual(await readFile(join(root, 'sample/assets/portrait.png')), sourceImage);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'sample/hocpkg-info.json'))), sourceManifest);
  if (mode !== 'png') {
    const chunk = pkg.files[path].subarray(12).toString('latin1');
    assert.ok(chunk.includes(mode === 'lossy' ? 'VP8 ' : 'VP8L'));
  }
});

test('rewrites only complete asset references, not longer names or ordinary prose', () => {
  const paths = new Map([['/assets/example.png', '/assets/example.webp']]);
  assert.equal(rewriteImageText('"/assets/example.png" url(/assets/example.png) "/assets/example.png.other"', paths), '"/assets/example.webp" url(/assets/example.webp) "/assets/example.png.other"');
});

test('embedded distribution uses descriptors and immutable directory assets without package containers', async () => {
  const tree = await buildPackageTree(root, imageOptions([], {}));
  const built = buildEmbeddedContent(tree), entry = built.content.packages[0];
  assert.equal(built.content.format, 'house-of-chances-embedded-content');
  assert.equal(entry.format, undefined); assert.equal(entry.formatVersion, undefined); assert.equal(entry.$schema, undefined);
  assert.equal(Object.keys(built.files).some(path => path.endsWith('hocpkg-info.json') || path.endsWith('.hocpkg')), false);
  assert.match(entry.base, /^\/embedded\/[a-f0-9]{64}\/$/);
  assert.equal(entry.identity.authorId, 'test');
  assert.equal(entry.startup['match.json'], tree.packages[0].files['match.json'].toString());
  assert.equal(entry.startup['assets/portrait.webp'], undefined);
  for (const resource of built.downloads) {
    const bytes = built.files[resource.url.slice(1)];
    assert.equal(bytes.length, resource.bytes); assert.equal(hash(bytes), resource.sha256);
  }
});

test('quality changes lossy bytes and cache entries for portraits and covers', async () => {
  const build = quality => buildPackageTree(root, { mode: 'lossy', quality, cacheDir: join(root, 'cache') });
  const low = (await build(1)).packages[0], high = (await build(100)).packages[0];
  assert.notDeepEqual(low.files['assets/portrait.webp'], high.files['assets/portrait.webp']);
  assert.deepEqual((await build(1)).packages[0].files, low.files);
  assert.notDeepEqual(low.files['cover.webp'], high.files['cover.webp']);
});

for (const mode of ['lossy', 'lossless', 'png']) test(`${mode}: encodes every skin cover reached through presentation refs`, async () => {
  const project = await mkdtemp(join(tmpdir(), 'hoc-skin-cover-build-'));
  try {
    await mkdir(join(project, 'sample/assets'), { recursive: true });
    const match = { presentationResourceId: 'appearance', definition: { assets: { cover: { presentationRef: 'cover-record', path: '/image' }, relaxed: 'assets/portrait.png' } } };
    const appearance = { skins: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], resources: {
      'cover-record': { type: 'data', variants: [{ skinId: 'a', value: { image: { presentationRef: 'cover-a' } } }, { skinId: 'b', value: { image: { presentationRef: 'cover-b' } } }] },
      'cover-a': { type: 'image', variants: [{ skinId: 'a', value: 'cover.png' }] },
      'cover-b': { type: 'image', variants: [{ skinId: 'b', value: 'alternate-cover.png' }] }
    } };
    const inputs = { 'match.json': Buffer.from(JSON.stringify(match)), 'appearance.json': Buffer.from(JSON.stringify(appearance)),
      'cover.png': sourceImage, 'alternate-cover.png': sourceImage, 'assets/portrait.png': sourceImage };
    const manifest = { ...sourceManifest, resources: [
      { id: 'match', type: 'game.character-match', apiVersion: 13, entry: 'match.json', requires: ['appearance'] },
      { id: 'appearance', type: 'presentation.character', apiVersion: 1, entry: 'appearance.json', requires: [] }
    ], files: Object.entries(inputs).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes), mediaType: path.endsWith('.png') ? 'image/png' : 'application/json' })) };
    for (const [file, bytes] of Object.entries(inputs)) await writeFile(join(project, 'sample', file), bytes);
    await writeFile(join(project, 'sample/hocpkg-info.json'), JSON.stringify(manifest));
    await writeFile(join(project, 'packages.json'), await readFile(join(root, 'packages.json')));
    const built = (await buildPackageTree(project, { mode, quality: 92 })).packages[0];
    for (const cover of ['cover.png', 'alternate-cover.png']) {
      const target = mode === 'png' ? cover : cover.replace('.png', '.webp');
      assert.ok(built.files[target]);
      assert.equal(built.manifest.files.find(file => file.path === target).mediaType, mode === 'png' ? 'image/png' : 'image/webp');
      assert.deepEqual(await readFile(join(project, 'sample', cover)), sourceImage);
      const record = built.images.find(image => image.source === cover);
      assert.equal(record.output, target);
      assert.equal(record.retainedPng, mode === 'png');
      if (mode !== 'png') assert.ok(built.files[target].subarray(12).toString('latin1').includes(mode === 'lossy' ? 'VP8 ' : 'VP8L'));
    }
    assert.ok(built.files[mode === 'png' ? 'assets/portrait.png' : 'assets/portrait.webp']);
    assert.deepEqual(JSON.parse(built.files['match.json']).definition.assets.cover, match.definition.assets.cover);
    const expected = JSON.parse(JSON.stringify(appearance).replaceAll('cover.png', mode === 'png' ? 'cover.png' : 'cover.webp'));
    assert.deepEqual(JSON.parse(built.files['appearance.json']), expected);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('cold cache accepts identical images encoded by concurrent package builds', async () => {
  const cacheDir = join(root, 'concurrent-cache');
  const trees = await Promise.all(Array.from({ length: 8 }, () => buildPackageTree(root, { mode: 'lossy', quality: 92, cacheDir })));
  const expected = trees[0].packages[0].files;
  for (const tree of trees) assert.deepEqual(tree.packages[0].files, expected);
  const entries = await readdir(cacheDir);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].endsWith('.webp'));
  assert.deepEqual(await readFile(join(cacheDir, entries[0])), expected['assets/portrait.webp']);
});

test('persistent build cache survives checkout cleanup and preserves encoded bytes', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hoc-image-plugin-'));
  const previous = process.env.HOC_BUILD_CACHE_DIR;
  process.env.HOC_BUILD_CACHE_DIR = join(project, 'persistent-cache');
  try {
    await mkdir(join(project, 'public/assets'), { recursive: true });
    await mkdir(join(project, 'public/characters'), { recursive: true });
    await writeFile(join(project, 'public/characters/packages.json'), JSON.stringify({ packages: [] }));
    await writeFile(join(project, 'public/assets/sample.png'), sourceImage);
    const first = imageBuildPlugin();
    const staged = await first.config({ root: project });
    const builtPath = (await readdir(join(staged.publicDir, 'assets'))).find(path => /^sample\.[a-f0-9]{64}\.webp$/.test(path));
    const bytes = await readFile(join(staged.publicDir, 'assets', builtPath));
    await first.closeBundle();
    const cached = await readdir(join(process.env.HOC_BUILD_CACHE_DIR, 'hoc-images'));
    assert.equal(cached.length, 1);
    await rm(join(project, 'node_modules'), { recursive: true, force: true });
    const second = imageBuildPlugin();
    const rebuilt = await second.config({ root: project });
    try { assert.deepEqual(await readFile(join(rebuilt.publicDir, 'assets', builtPath)), bytes); }
    finally { await second.closeBundle(); }
    assert.deepEqual(await readdir(join(process.env.HOC_BUILD_CACHE_DIR, 'hoc-images')), cached);
  } finally {
    if (previous === undefined) delete process.env.HOC_BUILD_CACHE_DIR;
    else process.env.HOC_BUILD_CACHE_DIR = previous;
    await rm(project, { recursive: true, force: true });
  }
});

test('rejects damaged source bytes instead of producing an apparently valid build', async () => {
  const path = join(root, 'sample/assets/portrait.png');
  await writeFile(path, Buffer.from('damaged'));
  try { await assert.rejects(buildPackageTree(root, imageOptions([], {})), /integrity mismatch/); }
  finally { await writeFile(path, sourceImage); }
});
