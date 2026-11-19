'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  openFiles: (opts) => ipcRenderer.invoke('file:open', opts),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  writeFile: (id, data) => ipcRenderer.invoke('file:write', id, data),
  readFile: (id) => ipcRenderer.invoke('file:read', id),
  info: () => ipcRenderer.invoke('app:info'),
  
});
