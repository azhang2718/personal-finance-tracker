// Preload — the only bridge between renderers and the main process.
// Exposes a minimal, promise-based API. No node integration in renderers.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getCache: (key) => ipcRenderer.invoke('get-cache', key),
  setCache: (key, value) => ipcRenderer.invoke('set-cache', key, value),
  getServerEnvStatus: () => ipcRenderer.invoke('get-server-env-status'),
  setServerEnv: (partial) => ipcRenderer.invoke('set-server-env', partial),
});
