const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__syncBridge', {
  onCommand: (callback) => ipcRenderer.on('sync:command', (_event, cmd) => callback(cmd)),
  onProgress: (callback) => ipcRenderer.on('sync:progress', (_event, progress) => callback(progress)),
  onFont: (callback) => ipcRenderer.on('font:set', (_event, index) => callback(index)),
  download: (name) => ipcRenderer.invoke('sync:download', name),
  listFiles: () => ipcRenderer.invoke('sync:list'),
  countFiles: () => ipcRenderer.invoke('sync:count'),
  upload: (name, data) => ipcRenderer.invoke('sync:upload', { name, data }),
  // 单对话文件夹方案
  listFolder: (folder) => ipcRenderer.invoke('sync:listFolder', folder),
  listDateFolders: () => ipcRenderer.invoke('sync:listDateFolders'),
  uploadSessionZip: (folder, fileName, data) =>
    ipcRenderer.invoke('sync:uploadSessionZip', { folder, fileName, data }),
  downloadZip: (folder, name) => ipcRenderer.invoke('sync:downloadZip', { folder, name }),
  uploadText: (folder, subFolder, fileName, text) =>
    ipcRenderer.invoke('sync:uploadText', { folder, subFolder, fileName, text }),
  listTextFiles: (folder, subFolder) =>
    ipcRenderer.invoke('sync:listTextFiles', { folder, subFolder }),
  downloadText: (folder, subFolder, fileName) =>
    ipcRenderer.invoke('sync:downloadText', { folder, subFolder, fileName }),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  downloadUpdate: (url) => ipcRenderer.invoke('app:downloadUpdate', { url }),
  notify: (message) => ipcRenderer.invoke('sync:notify', message),
  getSecret: (name) => ipcRenderer.invoke('secret:get', name),
  setSecret: (name, value) => ipcRenderer.invoke('secret:set', name, value),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  getZoom: () => ipcRenderer.invoke('zoom:get'),
  setZoom: (value) => ipcRenderer.invoke('zoom:set', value),
  getSyncAccount: () => ipcRenderer.invoke('sync:account:get'),
  setSyncAccount: (account) => ipcRenderer.invoke('sync:account:set', account),
  getBalance: () => ipcRenderer.invoke('balance:get'),
})
