const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__settingsBridge', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
})
