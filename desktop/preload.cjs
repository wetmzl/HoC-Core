const { contextBridge, ipcRenderer } = require('electron');

// No filesystem, process, URL, or generic IPC access crosses this bridge.
contextBridge.exposeInMainWorld('hocCoreUpdate', Object.freeze({
  networkStatus: () => ipcRenderer.invoke('hoc-core-update', 'networkStatus'),
  getStatus: options => ipcRenderer.invoke('hoc-core-update', 'getStatus', options),
  check: options => ipcRenderer.invoke('hoc-core-update', 'check', options),
  releaseNotes: () => ipcRenderer.invoke('hoc-core-update', 'releaseNotes'),
  download: options => ipcRenderer.invoke('hoc-core-update', 'download', options),
  cancel: () => ipcRenderer.invoke('hoc-core-update', 'cancel'),
  install: options => ipcRenderer.invoke('hoc-core-update', 'install', options),
  addListener: async (event, listener) => {
    if (event !== 'progress' || typeof listener !== 'function') throw new Error('更新事件无效。');
    const callback = (_event, progress) => listener(progress);
    ipcRenderer.on('hoc-core-update-progress', callback);
    return { remove: async () => { ipcRenderer.removeListener('hoc-core-update-progress', callback); } };
  }
}));
