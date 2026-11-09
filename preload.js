const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  toggleTuck: () => ipcRenderer.invoke('window-toggle-tuck'),
  untuck: () => ipcRenderer.invoke('window-untuck'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('window-toggle-aot'),
  getWindowState: () => ipcRenderer.invoke('window-get-state'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onTuckChanged: (callback) => {
    ipcRenderer.on('tuck-changed', (_event, isTucked) => callback(isTucked));
  },
  onAotChanged: (callback) => {
    ipcRenderer.on('aot-changed', (_event, isAot) => callback(isAot));
  }
});

