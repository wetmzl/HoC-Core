export const TARGET_FORMATS = Object.freeze({
  win: ['nsis', 'zip'], mac: ['dmg', 'zip'], linux: ['AppImage', 'tar.gz']
});

export const DESKTOP_RUNTIME_FILES = Object.freeze([
  'main.mjs', 'protocol.mjs', 'core-update.mjs', 'update-release.mjs',
  'update-chunks.mjs', 'network-status.mjs', 'preload.cjs'
]);

export function parseTarget(args, host = process.platform, hostArch = process.arch) {
  const options = { platform: { win32: 'win', darwin: 'mac', linux: 'linux' }[host], arch: hostArch };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=');
    if (!['--platform', '--arch', '--format'].includes(flag)) throw new Error(`未知参数：${args[i]}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    options[flag.slice(2)] = value;
  }
  if (!Object.hasOwn(TARGET_FORMATS, options.platform)) throw new Error('平台须为 win、mac 或 linux');
  if (!['x64', 'arm64'].includes(options.arch)) throw new Error('Electron 桌面目标仅支持 x64、arm64');
  if (options.format && !TARGET_FORMATS[options.platform].includes(options.format)) throw new Error('该平台不支持指定格式');
  return options;
}

export function buildConfig(root, version, target) {
  return {
    appId: 'io.github.wetmzl.hoc.core.desktop', productName: '命运牌桌',
    executableName: 'HoC-Core', artifactName: 'HoC-Core-${version}-${os}-${arch}.${ext}',
    electronVersion: version, asar: true, npmRebuild: false,
    directories: { app: `${root}/output/electron/app`, output: `${root}/output/electron/artifacts/${target.platform}-${target.arch}` },
    files: ['package.json', ...DESKTOP_RUNTIME_FILES.map(file => `desktop/${file}`), 'web/**/*', 'LICENSE', '!node_modules/**/*'],
    publish: null,
    electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true },
    win: { icon: `${root}/public/icons/app-icon-512.png`, signAndEditExecutable: process.platform === 'win32' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, differentialPackage: false },
    mac: {
      icon: `${root}/public/icons/app-icon-512.png`, category: 'public.app-category.games',
      // Fuses invalidate Electron's original signature. Always re-sign the
      // completed app, including certificate-free Apple Silicon test builds.
      identity: process.env.CSC_NAME || (process.env.CSC_LINK ? undefined : '-')
    },
    linux: { icon: `${root}/public/icons/app-icon-512.png`, category: 'Game', synopsis: '命运牌桌单机游戏', syncDesktopName: true }
  };
}
