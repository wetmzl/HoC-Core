import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, DESKTOP_RUNTIME_FILES, parseTarget, TARGET_FORMATS } from '../desktop/build-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'output/electron/app');
const [command, ...args] = process.argv.slice(2);
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

if (command === 'prepare' && args.length === 0) {
  // Stage a minimal app. Build-time tools and source checkouts never enter it.
  await readFile(join(root, 'output/electron/web/index.html'));
  await rm(appDir, { recursive: true, force: true });
  await mkdir(join(appDir, 'desktop'), { recursive: true });
  await cp(join(root, 'output/electron/web'), join(appDir, 'web'), { recursive: true });
  for (const file of DESKTOP_RUNTIME_FILES) await cp(join(root, 'desktop', file), join(appDir, 'desktop', file));
  await cp(join(root, 'LICENSE'), join(appDir, 'LICENSE'));
  await writeFile(join(appDir, 'package.json'), JSON.stringify({
    name: 'hoc-core-desktop', version: metadata.version, description: '命运牌桌单机游戏',
    author: 'HoC contributors', license: metadata.license, type: 'module', main: 'desktop/main.mjs', desktopName: 'HoC-Core.desktop'
  }, null, 2) + '\n');
  console.log(`Electron 应用已准备：${appDir}`);
} else if (command === 'start' && args.length === 0) {
  const { default: executable } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(executable, [appDir], { cwd: root, env, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else if (['pack', 'dist'].includes(command)) {
  const target = parseTarget(args);
  if (target.platform === 'mac' && process.platform !== 'darwin') throw new Error('macOS 产物请在 macOS 主机构建。');
  if (command === 'pack' && target.format) throw new Error('pack 不接受 --format，请用 dist');
  if (command === 'dist' && target.platform === 'win' && process.platform !== 'win32' && (!target.format || target.format === 'nsis')) {
    const wine = spawnSync('wine', ['--version'], { stdio: 'ignore' });
    if (wine.status !== 0) throw new Error('跨平台生成 NSIS 安装程序需要 Wine；请在 Windows 构建，或使用 --format zip 生成免安装包。');
  }
  await readFile(join(appDir, 'package.json'));
  const { build, Platform, Arch } = await import('electron-builder');
  const platform = { win: Platform.WINDOWS, mac: Platform.MAC, linux: Platform.LINUX }[target.platform];
  const config = buildConfig(root, metadata.devDependencies.electron, target);
  config.afterPack = async ({ appOutDir, packager }) => {
    const { listPackage } = await import('@electron/asar');
    const files = listPackage(join(packager.getResourcesDir(appOutDir), 'app.asar')).map(file => file.replaceAll('\\', '/'));
    const runtimePaths = new Set(DESKTOP_RUNTIME_FILES.map(file => `/desktop/${file}`));
    const unexpected = files.filter(file => !/^\/(?:web(?:\/|$)|desktop$|package\.json$|LICENSE$)/.test(file) && !runtimePaths.has(file));
    if (unexpected.length) throw new Error(`桌面运行包含有未允许的文件：${unexpected.slice(0, 5).join(', ')}`);
  };
  const paths = await build({
    projectDir: root, config, publish: 'never',
    targets: platform.createTarget(command === 'pack' ? ['dir'] : target.format ? [target.format] : TARGET_FORMATS[target.platform], Arch[target.arch])
  });
  if (command === 'dist') {
    const artifacts = [];
    for (const file of [...new Set(paths)].sort()) {
      const bytes = await readFile(file);
      artifacts.push({ file: file.slice(config.directories.output.length + 1), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    await writeFile(join(config.directories.output, 'delivery.json'), JSON.stringify({
      version: metadata.version, electron: config.electronVersion, ...target,
      sourceCommit: source.status === 0 ? source.stdout.trim() : null,
      sourceDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
      host: { platform: process.platform, arch: process.arch, node: process.versions.node }, artifacts
    }, null, 2) + '\n');
    await writeFile(join(config.directories.output, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
    console.log(`Electron 产物与摘要：${config.directories.output}`);
  }
} else throw new Error('用法：node scripts/electron.mjs prepare|start|pack|dist [--platform win|mac|linux] [--arch x64|arm64] [--format 格式]');
