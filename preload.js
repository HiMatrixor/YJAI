const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('YJAI', {
  isDesktop: true,
  platform: process.platform,

  // —— 授权 ——
  getMachineId: () => ipcRenderer.invoke('license:machine-id'),

  // —— 主窗口调用 ——
  isBrowserOpen: () => ipcRenderer.invoke('browser:isOpen'),
  openBrowserWindow: (url) => ipcRenderer.invoke('browser:open', url),
  focusBrowserWindow: () => ipcRenderer.invoke('browser:focus'),
  closeBrowserWindow: () => ipcRenderer.invoke('browser:close'),
  relayToBrowser: (msg) => ipcRenderer.invoke('browser:relay', msg),
  cdpClick: (payload) => ipcRenderer.invoke('browser:cdp-click', payload),
  cdpFill: (payload) => ipcRenderer.invoke('browser:cdp-fill', payload),

  // —— 浏览器窗口调用 ——
  onBrowserAction: (cb) => ipcRenderer.on('browser:action', (e, msg) => cb(msg)),
  onNavigate: (cb) => ipcRenderer.on('browser:navigate', (e, url) => cb(url)),
  sendBrowserResult: (id, result) => ipcRenderer.send('browser:result', { id, result }),

  // —— 自动更新 ——
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getVersion: () => ipcRenderer.invoke('update:version'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (e, payload) => cb(payload))
});
