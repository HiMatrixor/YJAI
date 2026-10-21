const { app, BrowserWindow, shell, Menu, ipcMain, webContents } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

let mainWin = null;
let browserWin = null;

/* ============ 未捕获异常兜底 ============ */
// 已知 Electron 内部问题：对 webview attach debugger 后，页面跳转/刷新销毁 render frame 时，
// Electron 内部事件处理器访问 WebFrameMain 会抛 "Render frame was disposed before
// WebFrameMain could be accessed"。该异常无功能影响（点击/提交均已成功），但默认会弹
// Error 对话框打断使用。这里兜底记录到日志，不弹框。
process.on('uncaughtException', (err) => {
  try {
    console.error('[uncaughtException]', err && (err.stack || err.message || err));
  } catch (_) {}
  // 静默：不打断用户操作
});

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

/* ============ CDP 真实输入点击（iframe 感知版） ============ */
// e卷通等平台的给分点/提交按钮在【跨域 iframe】（OOPIF，独立渲染进程）内：
// - 顶层派发合成事件 → 落在 iframe 外壳上，无效
// - attach 顶层 webContents 派发 CDP 事件 → 在 site isolation 下到不了 OOPIF 内部
// 正确做法：attach 顶层拿到 iframe 的 rect 与 src → 换算出 iframe 内局部坐标 →
// Target.getTargets 找到 iframe 对应 target → Target.attachToTarget 拿 sessionId →
// 在该 target 的 Input domain 用局部坐标派发 mouseMoved/Pressed/Released（自动生成 pointer+mouse+click）。
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

ipcMain.handle('browser:cdp-click', async (e, payload) => {
  const { webContentsId, x, y, times } = payload || {};
  // 渲染端不再传 webContentsId（webview.getWebContentsId() 走 GUEST_VIEW_MANAGER_CALL，
  // 在部分页面会报 "An object could not be cloned"），由主进程自动定位 webview guest
  let wc = null;
  if (webContentsId != null) wc = webContents.fromId(webContentsId);
  if (!wc) {
    const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
    wc = guests[0] || null;
  }
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview），请先打开浏览器并加载页面' };
  if (x == null || y == null) return { error: '缺少坐标' };
  const n = Math.max(1, Math.round(Number(times) || 1));
  let attached = false;
  let iframeHit = '';
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }

    // 1) 顶层文档探针：解析命中坐标处是否为跨域 iframe，并换算 iframe 内局部坐标
    const probe = await wc.debugger.sendCommand('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function(){
        function res(doc, cx, cy, depth){
          var el = doc.elementFromPoint(cx, cy);
          if(!el) return {hit:'NONE'};
          if((el.tagName==='IFRAME'||el.tagName==='FRAME') && depth<8){
            var r = el.getBoundingClientRect();
            var idoc = null;
            try{ idoc = el.contentDocument; }catch(err){}
            // 跨域 iframe：Chrome 访问 contentDocument 返回 null（不抛异常），必须按 null 判定
            if(idoc && el.contentWindow){
              var inner = res(idoc, cx-r.left, cy-r.top, depth+1);
              if(inner && inner.hit!=='NONE') return inner;
            }
            return {cross:true, ix:Math.round(cx-r.left), iy:Math.round(cy-r.top), src:el.src||'', id:(el.id||'')};
          }
          return {hit: el.tagName + (el.id?('#'+el.id):'')};
        }
        return res(document, ${x}, ${y}, 0);
      })()`
    });
    const info = (probe && probe.result && probe.result.value) || {};
    let tx = x, ty = y, sessionId = undefined, targetDesc = 'top';

    if (info.cross) {
      // 2) 跨域 iframe：诊断——attach iframe target 读取局部坐标处的元素（只读，用于日志）
      //    注意：实际点击仍在顶层 target 派发（与 Puppeteer 一致），由浏览器合成器路由进 OOPIF，
      //    直接对 OOPIF target 派发 Input 事件会被静默丢弃（这正是"日志成功但平台无反应"的原因）
      tx = x; ty = y; // 顶层坐标派发
      targetDesc = 'iframe:' + String(info.src||'').slice(0, 80);
      try {
        const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets');
        const srcBase = String(info.src || '').split('#')[0];
        const srcPath = srcBase.split('?')[0];
        const cands = (targetInfos || []).filter(t => t.type === 'iframe' && t.attached !== true);
        let best = null;
        for (const t of cands) {
          const u = String(t.url || '');
          if (srcBase && (u === srcBase || u.startsWith(srcBase))) { best = t; break; }
          if (srcPath && u.split('?')[0] === srcPath) { best = t; break; }
        }
        if (!best && cands.length) {
          try {
            const so = new URL(srcBase).origin;
            best = cands.find(t => { try { return new URL(t.url).origin === so; } catch (_) { return false; } });
          } catch (_) {}
        }
        if (best) {
          const at = await wc.debugger.sendCommand('Target.attachToTarget', { targetId: best.targetId, flatten: true });
          const sid = at.sessionId;
          try {
            const p2 = await wc.debugger.sendCommand('Runtime.evaluate', {
              returnByValue: true,
              expression: `(function(){ var el=document.elementFromPoint(${info.ix},${info.iy}); if(!el) return 'NONE'; return el.tagName+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+String(el.className).trim().split(/\\s+/).slice(0,2).join('.'):''); })()`
            }, sid);
            iframeHit = (p2 && p2.result && p2.result.value) || 'UNKNOWN';
          } catch (_) {}
          try { await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: sid }); } catch (_) {}
        }
      } catch (_) {}
    }

    // 3) 在顶层 target 派发完整点击序列（原始窗口坐标，由浏览器路由进 iframe）
    for (let i = 0; i < n; i++) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx, y: ty });
      await sleepMs(25);
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 1 });
      await sleepMs(45);
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 0 });
      await sleepMs(135);
    }
    if (sessionId) {
      try { await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId }); } catch (_) {}
    }
    return { ok: true, clicked: n, target: targetDesc, iframeHit: iframeHit, local: info.cross ? { x: info.ix, y: info.iy } : null };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e2) { /* ignore */ } }
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
