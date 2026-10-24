import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'dist/sdk');
const artifacts = join(root, 'dist/sdk-artifacts');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await build({
  configFile: false, root, publicDir: false, logLevel: 'warn',
  build: {
    target: 'es2022', outDir: target, emptyOutDir: false, minify: false,
    lib: { entry: { 'plugin-api': join(root, 'src/plugin-api.ts'), 'authoring-api': join(root, 'src/authoring-api.ts'), capabilities: join(root, 'src/sdk-capabilities.ts') }, formats: ['es'], fileName: (_, name) => `${name}.js` },
    rollupOptions: { external: ['zod'] }
  }
});
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.sdk.json'], { cwd: root, stdio: 'inherit' });
// Declarations reference other declarations only; explicit extensions also work with NodeNext consumers.
async function rewriteDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewriteDeclarations(path);
    else if (path.endsWith('.d.ts')) {
      const text = await readFile(path, 'utf8');
      const rewritten = text.replace(/(from\s+["']|import\(["'])(\.[^"']+)(["'])/g, (all, prefix, value, quote) => {
        if (/\.[a-z]+$/.test(value)) return all;
        return `${prefix}${value}.js${quote}`;
      });
      // TypeScript resolves directory index imports in source; resolve them for shipped declarations.
      const imports = [...rewritten.matchAll(/(?:from\s+["']|import\(["'])(\.[^"']+)\.js["']/g)];
      let output = rewritten;
      for (const [, value] of imports) {
        try { await readFile(join(dirname(path), value + '.d.ts')); }
        catch { try { await readFile(join(dirname(path), value, 'index.d.ts')); output = output.replaceAll(value + '.js', value + '/index.js'); } catch {} }
      }
      await writeFile(path, output);
    }
  }
}
await rewriteDeclarations(join(target, 'types'));
for (const name of ['package.json', 'cli.mjs', 'package-tools.d.mts']) await cp(join(root, 'sdk', name), join(target, name));
for (const name of ['image-build.mjs', 'audio-build.mjs', 'package-tools.mjs']) await cp(join(root, 'scripts', name), join(target, name));
await mkdir(join(target, 'types/scripts'), { recursive: true });
const imageTypes = (await readFile(join(root, 'scripts/image-build.d.mts'), 'utf8'))
  .replace("import type { Plugin } from 'vite';\n", '')
  .replace("'../src/content/packages/schema'", "'../src/content/packages/schema.js'")
  .replaceAll('Buffer', 'Uint8Array').replace('NodeJS.ProcessEnv', 'Record<string, string | undefined>')
  .replace('imageBuildPlugin(): Plugin', 'imageBuildPlugin(): unknown');
await writeFile(join(target, 'types/scripts/image-build.d.mts'), imageTypes);
await cp(join(root, 'scripts/audio-build.d.mts'), join(target, 'types/scripts/audio-build.d.mts'));
// Ship only the public declaration graph, not unrelated declarations reached by source implementation imports.
const reachable = new Set();
async function visitTypes(path) {
  if (reachable.has(path)) return;
  reachable.add(path);
  const text = await readFile(path, 'utf8');
  for (const [, reference] of text.matchAll(/(?:from\s+["']|import\(["'])(\.[^"']+)["']/g)) {
    const declaration = reference.replace(/\.js$/, '.d.ts').replace(/\.mjs$/, '.d.mts');
    await visitTypes(resolve(dirname(path), declaration));
  }
}
for (const path of ['src/plugin-api.d.ts', 'src/authoring-api.d.ts', 'src/sdk-capabilities.d.ts', 'scripts/image-build.d.mts']) await visitTypes(join(target, 'types', path));
async function pruneTypes(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await pruneTypes(path);
    else if (!reachable.has(path)) await rm(path);
  }
}
await pruneTypes(join(target, 'types'));
await cp(join(root, 'schemas'), join(target, 'schemas'), { recursive: true });
await cp(join(root, 'LICENSE'), join(target, 'LICENSE'));
await mkdir(artifacts, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', target, '--pack-destination', artifacts, '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
const bytes = await readFile(join(artifacts, packed.filename));
await writeFile(join(artifacts, 'sdk.json'), JSON.stringify({ name: packed.name, version: packed.version, file: packed.filename, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, null, 2) + '\n');
console.log(`SDK: ${join(artifacts, packed.filename)}`);
