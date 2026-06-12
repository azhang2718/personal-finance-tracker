// Preload — the only bridge between renderers and the main process.
// Exposes a minimal, promise-based API. No node integration in renderers.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('set-settings', partial),
  getCache: (key) => ipcRenderer.invoke('get-cache', key),
  setCache: (key, value) => ipcRenderer.invoke('set-cache', key, value),
});
