const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cxeify', {
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  openBrowser: () => ipcRenderer.invoke('open-browser'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  onServerStarted: (callback) => ipcRenderer.on('server-started', callback),
  onServerError: (callback) => ipcRenderer.on('server-error', (event, msg) => callback(msg)),
});
