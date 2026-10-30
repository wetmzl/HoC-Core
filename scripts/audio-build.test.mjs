import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAudio } from './audio-build.mjs';
import { buildPackageTree } from './image-build.mjs';

let root, wav, opus;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'hoc-audio-build-'));
  // A generated neutral stereo tone, with no game or third-party media dependency.
  wav = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-ac', '2', '-f', 'wav', 'pipe:1']);
  opus = (await buildAudio(wav, 'tone.wav')).bytes;
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('uses 80 kbps constrained VBR for bgm folders and 64 kbps VBR for effects', async () => {
  for (const [source, kbps, vbr] of [['assets/bgm/tone.wav', 80, 'constrained'], ['bgm/tone.wav', 80, 'constrained'], ['assets/tone.wav', 64, 'on']]) {
    const built = await buildAudio(wav, source);
    assert.equal(built.record.kbps, kbps);
    assert.equal(built.record.vbr, vbr);
    assert.equal(built.record.retainedOpus, false);
    assert.equal(built.record.sourceSha256, hash(wav));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'json', '-i', 'pipe:0'], {input: built.bytes}));
    assert.equal(probe.streams[0].codec_name, 'opus');
    assert.equal(probe.streams[0].channels, 2);
    execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], {input: built.bytes});
  }
});

test('detects existing Opus by codec, preserving all bytes and names even in .ogg', async () => {
  for (const source of ['tone.ogg', 'tone.opus', 'bgm/tone.ogg']) {
    const built = await buildAudio(opus, source);
    assert.deepEqual(built.bytes, opus);
    assert.equal(built.record.output, source);
    assert.equal(built.record.retainedOpus, true);
    assert.equal(built.record.kbps, null);
  }
});

test('accepts a probe finishing before a large PCM input has drained', async () => {
  const large = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-ac', '2', '-ar', '48000', '-f', 'wav', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
  assert.ok(large.length > 3 * 1024 * 1024);
  const built = await buildAudio(large, 'bgm/large-neutral-tone.wav');
  assert.equal(built.record.kbps, 80);
  assert.ok(built.bytes.length > 0);
});

test('cold encodes and cached encodes are byte deterministic', async () => {
  const first = await buildAudio(wav, 'tone.wav');
  const second = await buildAudio(wav, 'tone.wav', {cacheDir: join(root, 'cache')});
  const third = await buildAudio(wav, 'tone.wav', {cacheDir: join(root, 'cache')});
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(second.bytes, third.bytes);
});

async function fixture(files) {
  const directory = await mkdtemp(join(root, 'package-'));
  await mkdir(join(directory, 'sample/assets'), {recursive: true});
  const types = {wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', json: 'application/json', js: 'text/javascript', css: 'text/css'};
  const manifest = {identity: {authorId: 'example', packageName: 'sample', version: '1.0.0'}, resources: [], files: Object.entries(files).map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes), mediaType: types[path.split('.').at(-1)]}))};
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(directory, 'sample', path), bytes);
  await writeFile(join(directory, 'sample/hocpkg-info.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'packages.json'), JSON.stringify({packages: [{packageId: 'example/sample', version: '1.0.0', manifest: 'sample/hocpkg-info.json'}]}));
  return directory;
}

test('packages rewrite JSON/JS/CSS references and integrity while retaining sources and existing Opus', async () => {
  const files = {'assets/tone.wav': wav, 'assets/ready.ogg': opus,
    'data.json': Buffer.from(JSON.stringify({effect: 'assets/tone.wav', already: 'assets/ready.ogg'})),
    'module.js': Buffer.from('play("assets/tone.wav"); play("/characters/sample/assets/tone.wav");'),
    'style.css': Buffer.from('a {src:url(assets/tone.wav)}')};
  const directory = await fixture(files);
  const original = await readFile(join(directory, 'sample/hocpkg-info.json'));
  const build = () => buildPackageTree(directory, {mode: 'png', quality: 92});
  const tree = await build(), pkg = tree.packages[0];
  assert.equal(pkg.files['assets/tone.wav'], undefined);
  assert.ok(pkg.files['assets/tone.opus']);
  assert.deepEqual(pkg.files['assets/ready.ogg'], opus);
  assert.equal(JSON.parse(pkg.files['data.json']).effect, 'assets/tone.opus');
  assert.match(pkg.files['module.js'].toString(), /play\("assets\/tone.opus"\)/);
  assert.match(pkg.files['module.js'].toString(), /\/characters\/sample\/assets\/tone.opus/);
  assert.match(pkg.files['style.css'].toString(), /url\(assets\/tone.opus\)/);
  assert.equal(pkg.manifest.files.find(file => file.path === 'assets/tone.opus').mediaType, 'audio/ogg');
  for (const file of pkg.manifest.files) {
    assert.equal(file.bytes, pkg.files[file.path].length);
    assert.equal(file.sha256, hash(pkg.files[file.path]));
  }
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(directory, 'sample', path)), bytes);
  assert.deepEqual(await readFile(join(directory, 'sample/hocpkg-info.json')), original);
  assert.equal((await build()).index.releaseDigest, tree.index.releaseDigest);
});

test('rejects converted path collisions instead of silently discarding an asset', async () => {
  const directory = await fixture({'assets/tone.wav': wav, 'assets/tone.opus': opus});
  await assert.rejects(buildPackageTree(directory, {mode: 'png', quality: 92}), /output path collision/);
});

test('rejects corrupt audio and reports missing external build tools clearly', async () => {
  await assert.rejects(buildAudio(Buffer.from('damaged audio'), 'broken.wav'), /ffprobe failed/);
  const script = `import {buildAudio} from ${JSON.stringify(new URL('./audio-build.mjs', import.meta.url).href)}; await buildAudio(new Uint8Array([1]), 'tone.wav');`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, PATH: ''}, stdio: 'pipe'}), error => /Audio build requires ffmpeg/.test(error.stderr.toString()));
});
