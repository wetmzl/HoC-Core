import { AUDIO_ENCODING } from './audio-build.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { zip } from 'fflate';
import { buildPackageTree, imageOptions } from './image-build.mjs';

const options = { ...imageOptions(process.argv.slice(2)), cacheDir: resolve('node_modules/.cache/hoc-images'), audioCacheDir: resolve('node_modules/.cache/hoc-audio') };
if (options.forwarded.length) throw new Error('Usage: npm run build:packages -- [--images lossy|lossless|png] [--quality 1..100]');
const tree = await buildPackageTree(resolve('public/characters'), options);
const archive = files => new Promise((ok, fail) => zip(files, { level: 0, mtime: new Date(1980, 0, 1) }, (error, bytes) => error ? fail(error) : ok(bytes)));
const target = resolve('dist/packages');
await mkdir(target, { recursive: true });
const files = {};
for (const pkg of tree.packages) {
  const name = `${pkg.manifest.identity.packageName}.hocpkg`;
  files[name] = await archive(pkg.files);
  await writeFile(join(target, name), files[name]);
}
await writeFile(join(target, 'HoC-official.zip'), await archive(files));
await writeFile(join(target, 'image-build.json'), JSON.stringify({ mode: options.mode, quality: options.mode === 'lossy' ? options.quality : null, resize: false, index: tree.index, packages: tree.packages.map(pkg => ({ packageId: pkg.entry.packageId, images: pkg.images })) }, null, 2) + '\n');
console.log(`Built ${tree.packages.length} official packages (${options.mode}) in ${target}`);

await writeFile(join(target, 'audio-build.json'), JSON.stringify({ ...AUDIO_ENCODING, packages: tree.packages.map(pkg => ({ packageId: pkg.entry.packageId, audio: pkg.audio })) }, null, 2) + '\n');
