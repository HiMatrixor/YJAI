const { app, BrowserWindow, shell, Menu, ipcMain, webContents } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

let mainWin = null;
let browserWin = null;

/* ============ 自动更新 ============ */
// 仅在打包后的环境中启用（开发环境 require 不到 app-update.yml 时会静默跳过）
autoUpdater.autoDownload = false;   // 先检查，让用户确认后再下载
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

function sendUpdate(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => sendUpdate('update:status', { state: 'checking' }));
autoUpdater.on('update-available', (info) => sendUpdate('update:status', { state: 'available', info }));
autoUpdater.on('update-not-available', (info) => sendUpdate('update:status', { state: 'none', info }));
autoUpdater.on('error', (err) => sendUpdate('update:status', { state: 'error', message: String(err && err.message || err) }));
autoUpdater.on('download-progress', (p) => sendUpdate('update:status', { state: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total }));
autoUpdater.on('update-downloaded', (info) => sendUpdate('update:status', { state: 'downloaded', info }));

ipcMain.handle('update:check', () => {
  try { autoUpdater.checkForUpdates(); return true; }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('update:download', () => {
  try { autoUpdater.downloadUpdate(); return true; }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('update:install', () => {
  try { autoUpdater.quitAndInstall(false, true); return true; }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('update:version', () => ({ version: app.getVersion() }));

function getBrowserWin() {
  return (browserWin && !browserWin.isDestroyed()) ? browserWin : null;
}

/* 生成机器码：优先 Windows 注册表 MachineGuid，失败则用硬件信息哈希 */
function getMachineId() {
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8', windowsHide: true });
      const m = out.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      if (m) return m[0].toUpperCase();
    } catch (e) { /* fall through */ }
  }
  const raw = os.hostname() + '|' + (os.cpus()[0] ? os.cpus()[0].model : '') + '|' + os.totalmem() + '|' + os.platform();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32).toUpperCase();
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'YJAI · AI 阅卷助手',
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWin.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWin.loadFile('index.html');
}

/* ============ IPC：机器码 ============ */
ipcMain.handle('license:machine-id', () => {
  return getMachineId();
});

/* ============ IPC：独立浏览器窗口 ============ */
ipcMain.handle('browser:isOpen', () => {
  const bw = getBrowserWin();
  return !!(bw);
});

ipcMain.handle('browser:open', (e, url) => {
  let bw = getBrowserWin();
  if (!bw) {
    bw = new BrowserWindow({
      width: 1280,
      height: 880,
      minWidth: 800,
      minHeight: 560,
      title: 'YJAI 浏览器',
      backgroundColor: '#0e1116',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    bw.setMenuBarVisibility(false);
    bw.on('closed', () => { browserWin = null; });
    browserWin = bw;
    bw.loadFile('browser.html');
  }
  if (url) {
    // 等待浏览器窗口 dom-ready 后导航
    bw.webContents.send('browser:navigate', url);
  }
  bw.show();
  bw.focus();
  return true;
});

ipcMain.handle('browser:focus', () => {
  const bw = getBrowserWin();
  if (bw) { bw.show(); bw.focus(); return true; }
  return false;
});

ipcMain.handle('browser:close', () => {
  const bw = getBrowserWin();
  if (bw) { bw.close(); return true; }
  return false;
});

// 主窗口 -> 浏览器窗口 的请求/响应通道
ipcMain.handle('browser:relay', (e, msg) => {
  const bw = getBrowserWin();
  if (!bw) return { error: '浏览器窗口未打开，请先点击「打开浏览器」' };
  const id = msg && msg.id ? msg.id : String(Date.now());
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; clearTimeout(timer); ipcMain.removeListener('browser:result', handler); resolve(val); } };
    const handler = (ev, res) => {
      if (ev.sender === bw.webContents && res && res.id === id) finish(res.result);
    };
    const timer = setTimeout(() => finish({ error: '操作超时' }), 120000);
    ipcMain.on('browser:result', handler);
    bw.webContents.send('browser:action', { id, action: msg.action, data: msg.data });
  });
});

/* ============ CDP 真实输入点击（通过 DevTools Protocol，自动生成 pointer+mouse+click） ============ */
// 用于 e卷通等 Canvas 平台：webview.sendInputEvent 的 mouseDown 不生成 Pointer Events，
// 而 Canvas 给分点通常监听 pointerdown/pointerup。CDP Input.dispatchMouseEvent 走完整输入管线，最可靠。
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

ipcMain.handle('browser:cdp-click', async (e, payload) => {
  const { webContentsId, x, y, times } = payload || {};
  if (webContentsId == null) return { error: '缺少 webContentsId' };
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return { error: '目标页面已关闭' };
  const n = Math.max(1, Math.round(Number(times) || 1));
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attached = true;
    }
    for (let i = 0; i < n; i++) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleepMs(25);
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleepMs(45);
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleepMs(135);
    }
    return { ok: true, clicked: n };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e) { /* ignore */ } }
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 启动后延迟自动检查更新（仅打包环境生效）
  setTimeout(() => {
    try { autoUpdater.checkForUpdates(); } catch (e) { /* 开发环境忽略 */ }
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
