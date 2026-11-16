import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildConfig, parseTarget } from '../desktop/build-config.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('validates cross-platform targets before invoking build tools', () => {
  assert.deepEqual(parseTarget([], 'darwin', 'arm64'), { platform: 'mac', arch: 'arm64' });
  assert.deepEqual(parseTarget(['--platform', 'win', '--arch=arm64', '--format=zip'], 'linux', 'x64'),
    { platform: 'win', arch: 'arm64', format: 'zip' });
  for (const args of [['--platform'], ['--arch=ia32'], ['--platform=android'], ['--format=dmg'], ['--publish=always']]) {
    assert.throws(() => parseTarget(args, 'linux', 'x64'));
  }
});

test('prepared app contains every local runtime import and the packaging config includes it', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'hoc-electron-prepare-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'scripts'));
  await mkdir(join(fixture, 'output/electron/web'), { recursive: true });
  await cp(join(root, 'desktop'), join(fixture, 'desktop'), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'scripts/electron.mjs']) await cp(join(root, file), join(fixture, file));
  await writeFile(join(fixture, 'output/electron/web/index.html'), '<!doctype html><title>Desktop fixture</title>');

  await execute(process.execPath, [join(fixture, 'scripts/electron.mjs'), 'prepare']);

  const app = join(fixture, 'output/electron/app');
  const runtime = await readdir(join(app, 'desktop'));
  assert(runtime.includes('network-status.mjs'));
  assert(!runtime.some(file => file.endsWith('.test.mjs')));
  const config = buildConfig(fixture, '45.2.3', { platform: 'linux', arch: 'x64' });
  for (const file of runtime) {
    const source = await readFile(join(app, 'desktop', file), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = resolve(app, 'desktop', specifier);
      await assert.doesNotReject(readFile(dependency), `${file} depends on ${specifier}`);
      assert(config.files.includes(`desktop/${specifier.slice(2)}`), `packaging omits ${specifier}`);
    }
  }
});

