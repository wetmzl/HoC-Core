import { app, BrowserWindow, Menu, dialog, net, protocol, session, ipcMain, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { networkStatus } from './network-status.mjs';
import { DesktopCoreUpdater } from './core-update.mjs';
import { APP_URL, createAssetHandler, isAppUrl } from './protocol.mjs';

// Register before ready: OPFS, IndexedDB, module workers and fetch need a
// standard secure origin. Keep this URL stable across versions and installs.
protocol.registerSchemesAsPrivileged([{
  scheme: 'hoc',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

app.setName('命运牌桌');
const userData = process.env.HOC_ELECTRON_USER_DATA_DIR || join(app.getPath('appData'), 'HoC-Core');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

let window;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  app.whenReady().then(async () => {
    const webRoot = join(app.getAppPath(), 'web');
    protocol.handle('hoc', createAssetHandler(webRoot, (url, options) => net.fetch(url, options)));
    const updater = new DesktopCoreUpdater({
      directory: join(userData, 'core-updates'), version: app.getVersion(), supported: app.isPackaged,
      fetchImpl: (url, options) => net.fetch(url, options),
      openPath: path => shell.openPath(path), showItemInFolder: path => shell.showItemInFolder(path),
      restart: execPath => { app.relaunch({ execPath, args: [] }); app.quit(); },
      onProgress: progress => { if (window && !window.isDestroyed()) window.webContents.send('hoc-core-update-progress', progress); }
    });
    ipcMain.handle('hoc-core-update', (event, operation, options) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url))
        throw new Error('应用更新仅允许从主窗口调用。');
      if (operation === 'networkStatus') return networkStatus().then(status => ({ ...status, connected: net.isOnline() }));
      if (!['getStatus', 'check', 'releaseNotes', 'download', 'cancel', 'install'].includes(operation)) throw new Error('更新操作无效。');
      const channel = options?.channel ?? 'stable';
      if (!['stable', 'latest'].includes(channel)) throw new Error('更新通道无效。');
      return updater[operation](operation === 'download' ? { tag: typeof options?.tag === 'string' ? options.tag : '', channel } : { channel });
    });
    app.on('before-quit', () => updater.cancel());
    // Imported plugins stay sandboxed; the bridge only exposes fixed Core update operations.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(permission === 'persistent-storage' && isAppUrl(details.requestingUrl));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
      permission === 'persistent-storage' && isAppUrl(origin));
    session.defaultSession.on('will-download', (_event, item) => {
      if (!isAppUrl(item.getURL()) && !item.getURL().startsWith('blob:hoc://app/')) item.cancel();
    });

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' }
    ]));

    const createWindow = async () => {
      window = new BrowserWindow({
        title: '命运牌桌', width: 480, height: 900, minWidth: 360, minHeight: 640,
        backgroundColor: '#171421', show: false, autoHideMenuBar: true,
        icon: join(webRoot, 'icons/app-icon-512.png'),
        webPreferences: {
          preload: join(app.getAppPath(), 'desktop/preload.cjs'),
          nodeIntegration: false, contextIsolation: true, sandbox: true,
          webSecurity: true, devTools: !app.isPackaged
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        window.webContents.on(event, event => {
          if (!isAppUrl(event.url)) event.preventDefault();
        });
      }
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.once('ready-to-show', () => window.show());
      window.on('closed', () => { window = undefined; });
      await window.loadURL(APP_URL);
    };

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
    await createWindow();
  }).catch(error => {
    dialog.showErrorBox('命运牌桌启动失败', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
