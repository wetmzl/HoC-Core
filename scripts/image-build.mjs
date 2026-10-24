import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { AUDIO_ENCODING, buildAudio, isAudioPath } from './audio-build.mjs';

const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
const digestJson = value => sha(JSON.stringify(normalize(value)));

export function imageOptions(args = [], env = process.env) {
  let mode = env.HOC_IMAGE_MODE ?? 'lossy', quality = env.HOC_IMAGE_QUALITY ?? '92';
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=', 2);
    if (flag === '--images' || flag === '--quality') {
      const value = inline ?? args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--images') mode = value; else quality = value;
    } else forwarded.push(args[i]);
  }
  if (!['lossy', 'lossless', 'png'].includes(mode)) throw new Error('Image mode must be lossy, lossless or png');
  if (!/^\d+$/.test(String(quality)) || Number(quality) < 1 || Number(quality) > 100) throw new Error('Image quality must be an integer from 1 to 100');
  return { mode, quality: Number(quality), forwarded };
}

export function rewriteImageText(text, paths) {
  for (const [from, to] of paths) {
    for (const quote of ['"', "'", '`']) text = text.replaceAll(quote + from + quote, quote + to + quote);
    text = text.replaceAll(`url(${from})`, `url(${to})`);
  }
  return text;
}

function rewriteJson(value, paths) {
  if (typeof value === 'string') return paths.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => rewriteJson(item, paths));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteJson(item, paths)]));
  return value;
}

async function parallel(items, work) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; results[i] = await work(items[i]); }
  }));
  return results;
}

async function encode(bytes, options) {
  if (options.mode === 'png') return bytes;
  const quality = options.mode === 'lossless' ? 100 : options.quality;
  const settings = { quality, alphaQuality: 100, lossless: options.mode === 'lossless', effort: 4 };
  const key = sha(JSON.stringify({ versions: sharp.versions, settings, icc: 'keep' }) + sha(bytes));
  const cached = options.cacheDir && join(options.cacheDir, `${key}.webp`);
  if (cached) {
    try { return await readFile(cached); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // No resizing or alpha quantization. Source PNGs are never overwritten.
  const result = await sharp(bytes).keepIccProfile().webp(settings).toBuffer();
  if (cached) {
    await mkdir(dirname(cached), { recursive: true });
    const temporary = `${cached}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, result); await rename(temporary, cached); }
    finally { await rm(temporary, { force: true }); }
  }
  return result;
}

export async function buildPackage(charactersRoot, entry, options) {
  const manifestPath = join(charactersRoot, entry.manifest);
  const originalManifest = await readFile(manifestPath);
  const source = JSON.parse(originalManifest);
  if (`${source.identity.authorId}/${source.identity.packageName}` !== entry.packageId || source.identity.version !== entry.version) throw new Error(`Package index mismatch: ${entry.manifest}`);
  const sourceFiles = Object.fromEntries(await parallel(source.files, async file => {
    const bytes = await readFile(join(dirname(manifestPath), file.path));
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Source integrity mismatch: ${entry.packageId}#${file.path}`);
    return [file.path, bytes];
  }));
  const keepPng = new Set();
  // PNG character cards embed their package in the cover's PNG chunks.
  for (const resource of source.resources.filter(resource => resource.type === 'game.character-match')) {
    const body = JSON.parse(sourceFiles[resource.entry]);
    if (body.definition?.assets?.cover) keepPng.add(body.definition.assets.cover);
  }
  const images = source.files.filter(file => file.mediaType === 'image/png');
  const paths = new Map(images.filter(file => options.mode !== 'png' && !keepPng.has(file.path)).map(file => [file.path, file.path.replace(/\.png$/i, '.webp')]));
  const audio = new Map(await parallel(source.files.filter(file => file.mediaType.startsWith('audio/')), async file => {
    const built = await buildAudio(sourceFiles[file.path], file.path, { cacheDir: options.audioCacheDir });
    if (!built.record.retainedOpus) paths.set(file.path, built.record.output);
    return [file.path, built];
  }));
  const absolutePrefix = '/characters/' + entry.manifest.slice(0, entry.manifest.lastIndexOf('/') + 1);
  const references = new Map([...paths, ...[...paths].map(([from, to]) => [absolutePrefix + from, absolutePrefix + to])]);
  const imageReport = [];
  const files = Object.fromEntries(await parallel(source.files, async file => {
    const target = paths.get(file.path) ?? file.path;
    let bytes = sourceFiles[file.path];
    if (audio.has(file.path)) bytes = audio.get(file.path).bytes;
    else if (paths.has(file.path)) bytes = await encode(bytes, options);
    else if (paths.size && file.mediaType === 'application/json') bytes = jsonBytes(rewriteJson(JSON.parse(bytes), references));
    else if (paths.size && ['text/javascript', 'text/css'].includes(file.mediaType)) bytes = Buffer.from(rewriteImageText(bytes.toString(), references));
    if (file.mediaType === 'image/png') imageReport.push({ source: file.path, output: target, sourceSha256: file.sha256, sha256: sha(bytes), sourceBytes: file.bytes, bytes: bytes.length, retainedPng: keepPng.has(file.path) });
    return [target, bytes];
  }));
  if (Object.keys(files).length !== source.files.length) throw new Error(`Media output path collision: ${entry.packageId}`);
  const manifest = paths.size ? {
    ...rewriteJson(source, references),
    files: source.files.map(file => {
      const path = paths.get(file.path) ?? file.path, bytes = files[path];
      return { path, bytes: bytes.length, sha256: sha(bytes), mediaType: paths.has(file.path) ? (audio.has(file.path) ? 'audio/ogg' : 'image/webp') : file.mediaType };
    }).sort((a, b) => a.path.localeCompare(b.path))
  } : source;
  files['hocpkg-info.json'] = paths.size ? jsonBytes(manifest) : originalManifest;
  const canonicalManifest = { ...manifest, files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) };
  return {
    manifest, files, audio: [...audio.values()].map(item => item.record).sort((a, b) => a.source.localeCompare(b.source)), images: imageReport.sort((a, b) => a.source.localeCompare(b.source)),
    entry: { ...entry, contentDigest: digestJson(canonicalManifest), bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }
  };
}

export async function buildPackageTree(charactersRoot, options) {
  const source = JSON.parse(await readFile(join(charactersRoot, 'packages.json')));
  const packages = [];
  for (const entry of source.packages) packages.push(await buildPackage(charactersRoot, entry, options));
  const { releaseDigest: _previous, ...release } = { ...source, packages: packages.map(pkg => pkg.entry) };
  return { packages, index: { ...release, releaseDigest: digestJson(release) } };
}

async function visit(root, prefix = '') {
  const files = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await visit(root, path));
    else if (item.isFile()) files.push(path);
  }
  return files;
}

export function imageBuildPlugin() {
  let staging, projectRoot, report, audioReport;
  const paths = new Map();
  return {
    name: 'hoc-build-images', apply: 'build', enforce: 'pre',
    async config(config) {
      projectRoot = resolve(config.root ?? process.cwd());
      const cacheRoot = resolve(process.env.HOC_BUILD_CACHE_DIR ?? join(projectRoot, 'node_modules/.cache'));
      const options = { ...imageOptions(), cacheDir: join(cacheRoot, 'hoc-images'), audioCacheDir: join(cacheRoot, 'hoc-audio') };
      const source = resolve(projectRoot, typeof config.publicDir === 'string' ? config.publicDir : 'public');
      await mkdir(join(projectRoot, 'node_modules/.cache'), { recursive: true });
      staging = await mkdtemp(join(projectRoot, 'node_modules/.cache/hoc-public-'));
      try {
        const tree = await buildPackageTree(join(source, 'characters'), options);
        const written = new Set();
        const write = async (path, bytes) => {
          if (written.has(path)) throw new Error(`Media output path collision: ${path}`);
          written.add(path);
          const target = join(staging, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); };
        for (const pkg of tree.packages) for (const [path, bytes] of Object.entries(pkg.files)) {
          await write('characters/' + pkg.entry.manifest.slice(0, pkg.entry.manifest.lastIndexOf('/') + 1) + path, bytes);
        }
        await write('characters/packages.json', jsonBytes(tree.index));
        const shared = [], sharedAudio = [];
        paths.clear();
        for (const path of (await visit(source)).filter(path => !path.startsWith('characters/'))) {
          const bytes = await readFile(join(source, path));
          // Platform icons and the PNG save carrier retain their required formats.
          const convert = options.mode !== 'png' && path.startsWith('assets/') && path.endsWith('.png') && path !== 'assets/save-share-cover.png';
          const audio = isAudioPath(path) ? await buildAudio(bytes, path, { cacheDir: options.audioCacheDir }) : undefined;
          const target = audio ? audio.record.output : convert ? path.replace(/\.png$/, '.webp') : path;
          const output = audio ? audio.bytes : convert ? await encode(bytes, options) : bytes;
          if (target !== path) paths.set('/' + path, '/' + target);
          if (audio) sharedAudio.push(audio.record);
          await write(target, output);
          if (path.endsWith('.png')) shared.push({ source: path, output: target, sourceBytes: bytes.length, bytes: output.length });
        }
        report = { mode: options.mode, quality: options.mode === 'lossy' ? options.quality : null, resize: false, encoder: sharp.versions, packages: tree.packages.map(pkg => ({ packageId: pkg.entry.packageId, contentDigest: pkg.entry.contentDigest, images: pkg.images })), shared };
        audioReport = { ...AUDIO_ENCODING, packages: tree.packages.map(pkg => ({ packageId: pkg.entry.packageId, contentDigest: pkg.entry.contentDigest, audio: pkg.audio })), shared: sharedAudio };
        console.log(`Audio: Opus ${AUDIO_ENCODING.bgmKbps} kbps BGM / ${AUDIO_ENCODING.effectKbps} kbps effects; existing Opus retained`);
        console.log(`Images: ${options.mode}${options.mode === 'lossy' ? ` (quality ${options.quality})` : ''}; PNG sources unchanged`);
        return { publicDir: staging };
      } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    },
    transform(code) { const result = rewriteImageText(code, paths); return result === code ? null : { code: result, map: null }; },
    transformIndexHtml(html) { return rewriteImageText(html, paths); },
    async writeBundle(output) {
      await writeFile(resolve(projectRoot, output.dir, 'image-build.json'), jsonBytes(report));
      await writeFile(resolve(projectRoot, output.dir, 'audio-build.json'), jsonBytes(audioReport));
    },
    async closeBundle() { if (staging) await rm(staging, { recursive: true, force: true }); }
  };
}
