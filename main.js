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
autoUpdater.on('download-progress', (p) => sendUpdate('update:status', { state: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total }));
autoUpdater.on('update-downloaded', (info) => sendUpdate('update:status', { state: 'downloaded', info }));

// 错误处理：提取更详细的信息（错误码/网络错误/校验错误），并自动重试一次（应对 GitHub 资产域名偶发抖动）
let retryCount = 0;
autoUpdater.on('error', (err) => {
  const raw = String(err && err.message || err);
  let friendly = raw;
  // 常见错误友好化
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo|aborted|timed out|net::ERR/i.test(raw)) {
    friendly = '网络连接失败（GitHub 下载域名偶发不可达）: ' + raw;
  } else if (/cannot find latest|404|latest\.yml/i.test(raw)) {
    friendly = '未找到更新元数据（latest.yml）: ' + raw;
  } else if (/sha512|checksum|mismatch|integrity/i.test(raw)) {
    friendly = '更新包校验失败: ' + raw;
  }
  console.error('[update error]', err && (err.stack || err.message || err));
  // 网络类错误自动重试一次（延迟 3 秒）
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo|aborted|timed out|net::ERR/i.test(raw) && retryCount < 1) {
    retryCount++;
    sendUpdate('update:status', { state: 'checking', retry: retryCount });
    setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 3000);
    return;
  }
  retryCount = 0;
  sendUpdate('update:status', { state: 'error', message: friendly });
});

ipcMain.handle('update:check', () => {
  try { retryCount = 0; autoUpdater.checkForUpdates(); return true; }
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

// 聚焦浏览器窗口内的 webview 元素（让 guest 获得输入焦点，CDP 键盘输入才能生效）
ipcMain.handle('browser:focus-webview', () => {
  const bw = getBrowserWin();
  if (!bw) return false;
  bw.show();
  bw.focus();
  // 通过渲染进程让 webview 元素 focus
  bw.webContents.executeJavaScript(`(function(){ var wv=document.querySelector('webview'); if(wv){ try{ wv.focus(); }catch(e){} return !!wv; } return false; })()`).catch(()=>{});
  return true;
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
    const timer = setTimeout(() => finish({ error: '操作超时（10秒未响应，请确认浏览器窗口已打开并在浏览器窗口内点击目标）' }), 10000);
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

/* ============ OOPIF（跨域 iframe）CDP 会话发现 ============ */
// v1.9.14：17阅卷 / oemimoms 把整块打分板放进跨域 iframe。顶层 CDP Input 派发只会落在
// iframe 外壳上（日志「命中 FRAME」），分数填不进、提交点不动。必须 attach 到 iframe
// 自己的 session，在里面定位元素、派发输入/点击。
// 之前 Target.getTargets 总找不到 target：默认只发现 page 级 target，OOPIF 需要先开启
// Target.setDiscoverTargets（Puppeteer 靠 setAutoAttach 做同一件事）。
async function collectIframeSessions(wc, srcHint) {
  const diag = [];
  const sessions = [];
  let targetInfos = [];
  try {
    // 每次都开：handler 结束会 detach debugger，重连后 discover 开关会失效（幂等，重复调用无害）
    try { await wc.debugger.sendCommand('Target.setDiscoverTargets', { discover: true }); diag.push('discover=on'); }
    catch (e2) { diag.push('discover=ERR:' + String(e2 && e2.message || e2).slice(0, 50)); }
    try { await wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); diag.push('autoattach=on'); }
    catch (e2) { diag.push('autoattach=ERR:' + String(e2 && e2.message || e2).slice(0, 50)); }
    await sleepMs(220);
    const r = await wc.debugger.sendCommand('Target.getTargets');
    targetInfos = (r && r.targetInfos) || [];
  } catch (e2) { diag.push('getTargets=ERR:' + String(e2 && e2.message || e2).slice(0, 60)); }
  diag.push('targets=' + targetInfos.length + '[' + targetInfos.slice(0, 8).map(t => (t.type || '?') + ':' + String(t.url || '').split('?')[0].slice(-38)).join(' ') + ']');
  let origin = ''; try { origin = new URL(String(srcHint || '')).origin; } catch (_) {}
  const path = String(srcHint || '').split('#')[0].split('?')[0];
  const rank = (t) => {
    const u = String(t.url || '');
    if (path && u.split('#')[0].split('?')[0] === path) return 5;
    if (path && u.indexOf(path) >= 0) return 4;
    try { if (origin && new URL(u).origin === origin) return 3; } catch (_) {}
    return t.type === 'iframe' ? 2 : 1;
  };
  const cands = targetInfos.filter(t => t.url && t.url !== 'about:blank' && (t.type === 'iframe' || t.type === 'page'));
  cands.sort((a, b) => rank(b) - rank(a));
  for (const t of cands.slice(0, 10)) {
    let sid = null;
    try {
      const at = await wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      sid = at && at.sessionId;
    } catch (_) { continue; }
    if (sid) sessions.push({ sessionId: sid, targetId: t.targetId, url: String(t.url || ''), type: t.type, rank: rank(t) });
  }
  diag.push('sessions=' + sessions.length);
  return { sessions, diag: diag.join(' ') };
}
function releaseIframeSessions(wc, sessions) {
  for (const s of sessions || []) {
    try { const p = wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: s.sessionId }); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }
}

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
    let targetDesc = 'top', inFrameDone = false, mode = 'cdp-top', diag = '';

    if (info.cross) {
      // 2) 跨域 iframe：v1.9.14 关键修复。顶层派发只落在 iframe 外壳（日志「命中 FRAME」），
      //    平台毫无反应。改为 attach 到 iframe 自己的 CDP session，用【iframe 内局部坐标】
      //    在该 session 的 Input domain 派发点击（Puppeteer 的 frame.click 就是这个做法）。
      targetDesc = 'iframe:' + String(info.src || '').slice(0, 80);
      const col = await collectIframeSessions(wc, info.src);
      diag = col.diag;
      for (const s of col.sessions) {
        let hitEl = '';
        try {
          const p2 = await wc.debugger.sendCommand('Runtime.evaluate', {
            returnByValue: true,
            expression: `(function(){
              function tagOf(e){ return e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+String(e.className).trim().split(/\\s+/).slice(0,2).join('.'):''); }
              var el = document.elementFromPoint(${info.ix}, ${info.iy});
              if(!el) return JSON.stringify({r:'NONE'});
              return JSON.stringify({r:'OK', hit:tagOf(el), text:String(el.textContent||'').replace(/\\s+/g,'').slice(0,20), url:location.href});
            })()`
          }, s.sessionId);
          let o = {}; try { o = JSON.parse((p2 && p2.result && p2.result.value) || '{}'); } catch (_) {}
          if (o.r !== 'OK') continue;
          // 确认这个 session 就是目标 iframe（避免点进别的 frame）
          let same = false;
          try { same = new URL(o.url).origin === new URL(String(info.src || '')).origin; } catch (_) { same = true; }
          if (!same && s.rank < 3) continue;
          hitEl = o.hit + (o.text ? '(' + o.text + ')' : '');
        } catch (_) { continue; }
        // 在该 iframe session 内派发完整点击序列（局部坐标）
        try {
          for (let i = 0; i < n; i++) {
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.ix, y: info.iy }, s.sessionId);
            await sleepMs(25);
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.ix, y: info.iy, button: 'left', clickCount: 1, buttons: 1 }, s.sessionId);
            await sleepMs(45);
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.ix, y: info.iy, button: 'left', clickCount: 1, buttons: 0 }, s.sessionId);
            await sleepMs(135);
          }
          iframeHit = hitEl; inFrameDone = true; mode = 'iframe-session';
          break;
        } catch (_) {}
      }
      releaseIframeSessions(wc, col.sessions);
    }

    // 3) 没拿到可用 iframe session（或不在 iframe 内）才退回顶层派发
    if (!inFrameDone) {
      for (let i = 0; i < n; i++) {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleepMs(25);
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
        await sleepMs(45);
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
        await sleepMs(135);
      }
    }
    const warn = (info.cross && !inFrameDone) ? '未找到可用的 iframe 会话，点击只在顶层派发（可能落在 iframe 外壳上）' : '';
    return { ok: true, clicked: n, target: targetDesc, iframeHit: iframeHit, mode, verified: inFrameDone || !info.cross, warn, diag, local: info.cross ? { x: info.ix, y: info.iy } : null };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e2) { /* ignore */ } }
  }
});

/* ============ CDP 跨域 iframe 内输入框直接赋值 ============ */
// 面板给分等场景：分数输入框在跨域 iframe 内，顶层 querySelector 找不到。
// 拾取时记录 iframe 内局部坐标 (ix,iy)，此处 attach iframe target，
// 在 iframe 内 elementFromPoint 找到输入框并用原生 setter 赋值 + 派发 input/change。
ipcMain.handle('browser:cdp-fill', async (e, payload) => {
  const { x, y, value } = payload || {};
  let wc = null;
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  wc = guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  if (x == null || y == null) return { error: '缺少坐标' };
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    // 顶层探针：递归下钻（同源 iframe 可直接读 contentDocument）
    const probe = await wc.debugger.sendCommand('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function(){
        function res(doc, cx, cy, depth){
          var el = doc.elementFromPoint(cx, cy);
          if(!el) return {r:'NONE'};
          if((el.tagName==='IFRAME'||el.tagName==='FRAME') && depth<8){
            var r = el.getBoundingClientRect();
            var nx = Math.round(cx-r.left), ny = Math.round(cy-r.top);
            var idoc = null; try{ idoc = el.contentDocument; }catch(err){}
            if(idoc && el.contentWindow){
              var inner = res(idoc, nx, ny, depth+1);
              if(inner && inner.r === 'OK') return {r:'SAME', ix:nx, iy:ny, src:el.src||''};
            }
            return {r:'CROSS', cross:true, ix:nx, iy:ny, src:el.src||''};
          }
          if(el.tagName==='INPUT'||el.tagName==='TEXTAREA') return {r:'OK'};
          var i = el.querySelector('input, textarea');
          return i ? {r:'OK'} : {r:'NOT_INPUT'};
        }
        return res(document, ${x}, ${y}, 0);
      })()`
    });
    const info = (probe && probe.result && probe.result.value) || {};
    // 同源 iframe：顶层文档即可递归定位，直接原生 setter 赋值 + 派发 input/change（不需要 iframe target）
    if (info.r === 'SAME') {
      const r0 = await wc.debugger.sendCommand('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){
          function walk(doc, cx, cy, depth){
            var el=doc.elementFromPoint(cx,cy); if(!el) return null;
            if((el.tagName==='IFRAME'||el.tagName==='FRAME') && depth<8){
              var r=el.getBoundingClientRect(), idoc=null; try{ idoc=el.contentDocument; }catch(err){}
              if(idoc) return walk(idoc, cx-r.left, cy-r.top, depth+1);
              return null;
            }
            if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; else return null; }
            return el;
          }
          var el = walk(document, ${x}, ${y}, 0);
          if(!el) return JSON.stringify({r:'NONE'});
          var v = ${JSON.stringify(String(value))};
          var proto = (el.tagName==='TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          el.focus();
          if(setter) setter.call(el, v); else el.value = v;
          try{ el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v})); }
          catch(e){ try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e2){} }
          try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
          return JSON.stringify({r:'OK', v:el.value, hit:el.tagName+(el.id?'#'+el.id:'')});
        })()`
      });
      let o0 = {}; try { o0 = JSON.parse((r0 && r0.result && r0.result.value) || '{}'); } catch (_) {}
      if (o0.r === 'OK' && String(o0.v) === String(value)) return { ok: true, hit: o0.hit || '', mode: 'same-origin-dom' };
      return { error: '同源 iframe 内赋值回读不一致：实际=' + (o0.v || o0.r || '?'), hit: o0.hit || '' };
    }
    if (!info.cross) return { error: '目标不在 iframe 内，请用元素拾取模式' };
    // 找 iframe target：放宽匹配（同源 iframe / url 带动态参数 / 已 attach / type=page 的 OOPIF 都要能命中）
    const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets');
    const srcBase = String(info.src || '').split('#')[0];
    const srcPath = srcBase.split('?')[0];
    const cands = (targetInfos || []).filter(t => (t.type === 'iframe' || t.type === 'page') && t.url && t.url !== 'about:blank');
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
    if (!best) best = cands.find(t => t.type === 'iframe') || null;
    if (!best) return { error: '未找到 iframe 对应的渲染目标（src=' + srcBase + '），已改用顶层键盘输入' };
    const at = await wc.debugger.sendCommand('Target.attachToTarget', { targetId: best.targetId, flatten: true });
    const sid = at.sessionId;
    let result = '', hit = '';
    try {
      // 第一步：定位输入框并聚焦、清空
      const r1 = await wc.debugger.sendCommand('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){
          var el = document.elementFromPoint(${info.ix}, ${info.iy});
          if(!el) return JSON.stringify({r:'NONE'});
          function tagOf(e){ return e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+String(e.className).trim().split(/\\s+/).slice(0,2).join('.'):''); }
          if(el.tagName!=='INPUT' && el.tagName!=='TEXTAREA'){
            var inner = el.querySelector('input, textarea');
            if(inner) el = inner; else return JSON.stringify({r:'NOT_INPUT', hit: tagOf(el)});
          }
          el.focus();
          var proto = (el.tagName==='TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          if(setter) setter.call(el, ''); else el.value = '';
          try{ el.dispatchEvent(new Event('input', {bubbles:true})); }catch(e){}
          return JSON.stringify({r:'OK', hit: tagOf(el)});
        })()`
      }, sid);
      let o1 = {};
      try { o1 = JSON.parse((r1 && r1.result && r1.result.value) || '{}'); } catch(_) {}
      if (o1.r !== 'OK') {
        try { await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: sid }); } catch (_) {}
        return { error: 'iframe 内定位输入框失败: ' + o1.r, hit: o1.hit || '' };
      }
      hit = o1.hit || '';
      // 第二步：CDP 键盘输入（受信任的输入事件，React/Vue 受控组件可响应）
      await wc.debugger.sendCommand('Input.insertText', { text: String(value) }, sid);
      await sleepMs(150);
      // 第三步：验证 value 是否生效
      let finalVal = '';
      try {
        const r3 = await wc.debugger.sendCommand('Runtime.evaluate', {
          returnByValue: true,
          expression: `(function(){ var el=document.elementFromPoint(${info.ix}, ${info.iy}); if(!el) return ''; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } return el.value; })()`
        }, sid);
        finalVal = (r3 && r3.result && r3.result.value) || '';
      } catch (_) {}
      result = (String(finalVal) === String(value)) ? 'OK' : ('VALUE_MISMATCH:实际=' + finalVal);
    } catch (err2) { result = 'EVAL_ERR:' + (err2 && err2.message || err2); }
    try { await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: sid }); } catch (_) {}
    if (result === 'OK') return { ok: true, hit };
    return { error: 'iframe 内赋值失败: ' + result, hit };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e2) { /* ignore */ } }
  }
});

/* ============ CDP 顶层输入框键盘输入（受信任输入，Vue/React 受控组件必响应） ============ */
// 学科网 e卷通等平台：分数输入框在顶层页面（非 iframe），但 DOM 直接赋值有时触发不了 Vue 响应式。
// 这里用浏览器级 CDP Input.insertText 敲入数字，等效真实键盘输入。
// 入参：{ x, y, value } 坐标优先；也可传 { selector, value } 用选择器定位。
ipcMain.handle('browser:cdp-fill-top', async (e, payload) => {
  const { x, y, value, selector } = payload || {};
  let wc = null;
  // 优先选择「非空白」的 webview guest（已加载阅卷页面的那个），避免拿到 about:blank 的空 webview
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  if (guests.length) {
    wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u) && u !== ''; } catch (_) { return false; } }) || guests[0];
  }
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  const val = String(value);
  if (!val) return { error: '缺少要填入的值' };
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    // 先聚焦 webview guest 的页面（确保 CDP Input 事件能作用到输入框）
    try { await wc.debugger.sendCommand('Page.bringToFront'); } catch (_) {}

    // 1) 定位输入框：优先选择器，否则按坐标 elementFromPoint
    const locateExpr = selector
      ? `(function(){ var el=document.querySelector(${JSON.stringify(selector)}); if(!el) return JSON.stringify({r:'NOT_FOUND'}); function tagOf(e){ return e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+String(e.className).trim().split(/\\s+/).slice(0,2).join('.'):''); } if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; else return JSON.stringify({r:'NOT_INPUT',hit:tagOf(el)}); } var rr=el.getBoundingClientRect(); el.focus(); return JSON.stringify({r:'OK',hit:tagOf(el),cx:Math.round(rr.left+rr.width/2),cy:Math.round(rr.top+rr.height/2)}); })()`
      : `(function(){ var el=document.elementFromPoint(${x},${y}); if(!el) return JSON.stringify({r:'NONE'}); function tagOf(e){ return e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+String(e.className).trim().split(/\\s+/).slice(0,2).join('.'):''); } if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; else return JSON.stringify({r:'NOT_INPUT',hit:tagOf(el)}); } var rr=el.getBoundingClientRect(); el.focus(); return JSON.stringify({r:'OK',hit:tagOf(el),cx:Math.round(rr.left+rr.width/2),cy:Math.round(rr.top+rr.height/2)}); })()`;

    const r1 = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue: true, expression: locateExpr });
    let o1 = {};
    try { o1 = JSON.parse((r1 && r1.result && r1.result.value) || '{}'); } catch (_) {}
    if (o1.r !== 'OK') {
      return { error: '定位输入框失败: ' + o1.r + (o1.hit ? (' (' + o1.hit + ')') : '') };
    }
    const hit = o1.hit || '';

    // 2) 确保焦点：用 CDP 真实鼠标点击输入框中心（关键：Runtime.evaluate 的 el.focus() 不够，
    //    必须真实点击才能让 webview 内的输入框获得页面焦点，后续 Input.insertText 才能触发 Vue input 事件）
    const cx = (x != null && selector == null) ? x : o1.cx;
    const cy = (y != null && selector == null) ? y : o1.cy;
    if (cx != null && cy != null) {
      // 先确保 webview 页面在前台
      try { await wc.debugger.sendCommand('Page.bringToFront'); } catch (_) {}
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 0 });
      await sleepMs(150);
    }
    // 3) 全选现有内容（Ctrl+A），使 Input.insertText 直接覆盖选中区（受信任输入，Vue 必响应）
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await sleepMs(60);

    // 4) 用 Input.insertText 敲入数字（有选区则覆盖，无选区则插入光标处）
    await wc.debugger.sendCommand('Input.insertText', { text: val });
    await sleepMs(180);

    // 5) 回读验证：读 el.value，同时读 document.activeElement 确认焦点，并尝试读 Vue 组件绑定值
    let finalVal = '';
    let focusOk = false;
    try {
      const r3 = await wc.debugger.sendCommand('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){ var el=${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.elementFromPoint(${x},${y})`}; if(!el) return ''; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } var ae=document.activeElement; return JSON.stringify({v:el.value, focus:(ae===el), aeTag:(ae?ae.tagName:''), aeId:(ae&&ae.id?ae.id:'')}); })()`
      });
      let o = {};
      try { o = JSON.parse((r3 && r3.result && r3.result.value) || '{}'); } catch (_) {}
      finalVal = o.v || '';
      focusOk = !!o.focus;
    } catch (_) {}

    if (String(finalVal) === val) {
      // 值正确。若焦点不在输入框，说明 insertText 可能只改了 DOM 值没触发 Vue，改用逐字符 dispatchKeyEvent 重输一遍
      if (focusOk) return { ok: true, hit, mode: 'cdp-keyboard' };
      // 焦点不对：用逐字符 keyDown(char)+keyUp 键盘序列重输（更接近真实键盘，能触发 keydown/keypress/input 完整链）
      try {
        const clearExpr = `(function(){ var el=${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.elementFromPoint(${x},${y})`}; if(!el) return 'NOEL'; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } el.focus(); el.select(); return 'OK'; })()`;
        await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue: true, expression: clearExpr });
        await sleepMs(80);
        for (const ch of val) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
          await sleepMs(30);
        }
        await sleepMs(150);
        const r5 = await wc.debugger.sendCommand('Runtime.evaluate', {
          returnByValue: true,
          expression: `(function(){ var el=${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.elementFromPoint(${x},${y})`}; if(!el) return ''; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } var ae=document.activeElement; return JSON.stringify({v:el.value, focus:(ae===el)}); })()`
        });
        let o5 = {};
        try { o5 = JSON.parse((r5 && r5.result && r5.result.value) || '{}'); } catch (_) {}
        if (String(o5.v) === val) return { ok: true, hit, mode: 'cdp-char', focus: !!o5.focus };
      } catch (_) {}
      return { ok: true, hit, mode: 'cdp-keyboard', warn: '焦点未落在输入框' };
    }
    // 回读不一致：可能 insertText 追加到了旧值后面，尝试「全选+删除再 insertText」二次覆盖
    try {
      await wc.debugger.sendCommand('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){ var el=${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.elementFromPoint(${x},${y})`}; if(!el) return 'NOEL'; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } el.focus(); el.select(); return 'OK'; })()`
      });
      await wc.debugger.sendCommand('Input.insertText', { text: val });
      await sleepMs(180);
      const r4 = await wc.debugger.sendCommand('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){ var el=${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.elementFromPoint(${x},${y})`}; if(!el) return ''; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } return el.value; })()`
      });
      finalVal = (r4 && r4.result && r4.result.value) || '';
    } catch (_) {}
    if (String(finalVal) === val) return { ok: true, hit, mode: 'cdp-keyboard' };
    return { error: 'CDP 键盘输入后回读不一致：实际=' + finalVal, hit, mode: 'cdp-keyboard' };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e2) { /* ignore */ } }
  }
});

/* ============ iframe 内输入框：顶层 CDP 真实键盘输入（v1.9.13 关键修复） ============ */
// 17阅卷 / oemimoms 等平台把分数框放在 iframe 内（同源 iframe 或跨域 OOPIF 都有可能）。
// 旧路径 browser:cdp-fill 是「找 iframe 对应的 CDP target → 在该 target 内 DOM 赋值」，
// 一旦 Target.getTargets 找不到匹配 target（同源 iframe 没有独立 target、url 带动态参数、
// target 已被 attach 等），就直接报「未找到 iframe 对应的渲染目标」，键盘输入一次都没被调用。
// 正确做法（与 Puppeteer 一致）：在【顶层 target】用原始窗口坐标派发
//   mousePressed/Released → Ctrl+A → Input.insertText，
// 浏览器合成器会把鼠标与键盘事件自动路由进 iframe（含 OOPIF），Vue/React 受控输入同样响应。
/* ============ iframe 内分数框：在 iframe 自己的 CDP 会话内输入（v1.9.14） ============ */
// 17阅卷 / oemimoms 把整块打分板放在跨域 iframe（OOPIF）里。顶层派发的鼠标/键盘只落在
// iframe 外壳上，日志显示「命中 FRAME」「输入成功」，平台却毫无反应 —— 这正是 v1.9.13
// 的「假成功」。正确做法：开启 OOPIF 发现 → attach 到 iframe session → 在该 session 内
// 定位元素并派发 Input.insertText / 键盘链，键盘给分型平台也走同一条路。
ipcMain.handle('browser:cdp-fill-iframe', async (e, payload) => {
  const { x, y, value } = payload || {};
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  const wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u); } catch (_) { return false; } }) || guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  if (x == null || y == null) return { error: '缺少输入框坐标' };
  const val = String(value);
  if (!val) return { error: '缺少要填入的值' };
  let attached = false, sessions = [];
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    try { await wc.debugger.sendCommand('Page.bringToFront'); } catch (_) {}

    // 1) 顶层探针：是否命中 iframe、iframe 内局部坐标、iframe src
    const probe = await wc.debugger.sendCommand('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function(){
        function walk(doc, cx, cy, depth){
          var el = doc.elementFromPoint(cx, cy);
          if(!el) return {r:'NONE'};
          if((el.tagName==='IFRAME'||el.tagName==='FRAME') && depth<8){
            var r = el.getBoundingClientRect();
            var nx = Math.round(cx-r.left), ny = Math.round(cy-r.top);
            var idoc=null; try{ idoc=el.contentDocument; }catch(err){}
            if(idoc && el.contentWindow){
              var inner = walk(idoc, nx, ny, depth+1);
              if(inner && inner.r==='OK') return {r:'SAME', ix:nx, iy:ny, src:el.src||'', hit:inner.hit};
            }
            return {r:'CROSS', cross:true, ix:nx, iy:ny, src:el.src||''};
          }
          if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){
            var i = el.querySelector && el.querySelector('input,textarea');
            if(i) el=i; else return {r:'NOT_INPUT', hit:el.tagName};
          }
          return {r:'OK', hit:el.tagName+(el.id?'#'+el.id:'')};
        }
        return walk(document, ${x}, ${y}, 0);
      })()`
    });
    const info = (probe && probe.result && probe.result.value) || {};
    const ix = (info.ix != null ? info.ix : Math.round(x));
    const iy = (info.iy != null ? info.iy : Math.round(y));
    const src = String(info.src || '');

    let verified = false, hit = info.hit || '', mode = '', note = '', diag = '';
    let inFrameDone = false;

    // 2) 主路径：attach iframe session，在 iframe 内部派发（同源 / OOPIF 都适用）
    const col = await collectIframeSessions(wc, src);
    sessions = col.sessions; diag = col.diag;
    for (const s of sessions) {
      let loc = {};
      try {
        const rr = await wc.debugger.sendCommand('Runtime.evaluate', {
          returnByValue: true,
          expression: `(function(){
            var ix=${ix}, iy=${iy};
            function tagOf(e){ return e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+String(e.className).trim().split(/\\s+/).slice(0,2).join('.'):''); }
            function pick(el){
              if(!el) return null;
              if(el.tagName==='INPUT'||el.tagName==='TEXTAREA') return el;
              if(el.querySelector){ var q=el.querySelector('input,textarea'); if(q) return q; }
              var p=el; for(var k=0;k<3&&p;k++){ if(p.querySelector){ var q2=p.querySelector('input,textarea'); if(q2) return q2; } p=p.parentElement; }
              return null;
            }
            var el = pick(document.elementFromPoint(ix,iy)), how='point';
            if(!el){
              var all=document.querySelectorAll('input,textarea');
              for(var k=0;k<all.length;k++){
                var c=all[k], r=c.getBoundingClientRect();
                if(r.width<4||r.height<4) continue;
                var cl=String(c.className||'')+' '+String(c.getAttribute&&c.getAttribute('placeholder')||'');
                if(/scale|zoom|percent|[%％]/i.test(cl)) continue;
                var t=(c.type||'text').toLowerCase(); if(t!=='text'&&t!=='number'&&t!=='tel') continue;
                el=c; how='heuristic'; break;
              }
            }
            window.__yjaiScoreEl = el;
            return JSON.stringify({r: el?'OK':'NO_INPUT', hit: el?tagOf(el):'', how:how, url:location.href, isTop:(window.top===window.self), inputs:all?all.length:0});
          })()`
        }, s.sessionId);
        try { loc = JSON.parse((rr && rr.result && rr.result.value) || '{}'); } catch (_) {}
      } catch (_) { continue; }
      if (!loc.url) continue;
      if (loc.isTop && info.cross) continue;  // 顶层 frame 不是我们要的 iframe
      let related = false;
      try { related = src && new URL(loc.url).origin === new URL(src).origin; } catch (_) { related = true; }
      if (!related && s.rank < 3) continue;

      inFrameDone = true; mode = 'iframe-session';
      hit = loc.hit || hit;
      if (loc.r === 'OK') {
        // 2a) 聚焦 + 清空 → 在该 iframe session 内派发受信任文本输入
        try {
          await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){
            var el=window.__yjaiScoreEl; if(!el) return 'NO_EL';
            el.focus(); try{ el.select&&el.select(); }catch(e){}
            var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
            var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
            if(setter) setter.call(el,''); else el.value='';
            try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}
            return 'OK';
          })()` }, s.sessionId);
          await wc.debugger.sendCommand('Input.insertText', { text: val }, s.sessionId);
          await sleepMs(180);
          const rv = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){ var el=window.__yjaiScoreEl; return el?String(el.value):''; })()` }, s.sessionId);
          if (String((rv && rv.result && rv.result.value) || '') === val) verified = true;
        } catch (e2) { note = 'iframe 会话键盘输入异常: ' + String(e2 && e2.message || e2).slice(0,80); }
        // 2b) 受控组件没吃下键盘输入：原生 setter + input/change 显式通知
        if (!verified) {
          try {
            const rv2 = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){
              var el=window.__yjaiScoreEl, v=${JSON.stringify(val)}; if(!el) return '';
              var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
              var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
              if(setter) setter.call(el,v); else el.value=v;
              try{ el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v})); }
              catch(e){ try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e2){} }
              try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
              return String(el.value);
            })()` }, s.sessionId);
            if (String((rv2 && rv2.result && rv2.result.value) || '') === val) { verified = true; mode = 'iframe-dom-setter'; }
          } catch (_) {}
        }
      } else {
        // 2c) 该帧没有输入框（键盘给分型平台）：在 iframe 会话内直接敲数字键
        try {
          const keyA = { modifiers:2, key:'a', code:'KeyA', windowsVirtualKeyCode:65, nativeVirtualKeyCode:65 };
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({type:'keyDown'}, keyA), s.sessionId);
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({type:'keyUp'}, keyA), s.sessionId);
          await wc.debugger.sendCommand('Input.insertText', {text:val}, s.sessionId);
          for (const ch of val) {
            const vk = ch.charCodeAt(0);
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown', key:ch, text:ch, windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk}, s.sessionId);
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp', key:ch, windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk}, s.sessionId);
          }
          mode = 'iframe-keyboard';
          note = '该 iframe 内未找到输入框，已按「键盘给分」在 iframe 会话内派发数字键，请在浏览器窗口确认分数';
        } catch (e3) { note = 'iframe 会话键盘派发失败: ' + String(e3 && e3.message || e3).slice(0,80); }
      }
      break;  // 已在正确的 iframe 会话内派发，不要再对其它 frame 重复输入
    }

    // 3) 没拿到 iframe 会话：同源 iframe 顶层递归 DOM 赋值
    if (!inFrameDone && info.r === 'SAME') {
      try {
        const r0 = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){
          function walk(doc,cx,cy,d){ var el=doc.elementFromPoint(cx,cy); if(!el) return null;
            if((el.tagName==='IFRAME'||el.tagName==='FRAME')&&d<8){ var r=el.getBoundingClientRect(), idoc=null; try{idoc=el.contentDocument;}catch(e){} if(idoc) return walk(idoc,cx-r.left,cy-r.top,d+1); return null; }
            if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var q=el.querySelector('input,textarea'); if(q) el=q; else return null; }
            return el; }
          var el=walk(document, ${x}, ${y}, 0), v=${JSON.stringify(val)}; if(!el) return 'NONE';
          el.focus(); var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          var setter=Object.getOwnPropertyDescriptor(proto,'value').set; if(setter) setter.call(el,v); else el.value=v;
          try{ el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v})); }catch(e){ try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e2){} }
          try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
          return String(el.value);
        })()` });
        if (String((r0 && r0.result && r0.result.value) || '') === val) { verified = true; mode = 'same-origin-dom'; }
      } catch (_) {}
    }

    // 4) 仍失败：顶层派发（保留旧行为），但必须回读确认，不再伪装成成功
    if (!inFrameDone && !verified) {
      try {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', x, y});
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1, buttons:1});
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1, buttons:0});
        await sleepMs(120);
        const keyA = { modifiers:2, key:'a', code:'KeyA', windowsVirtualKeyCode:65, nativeVirtualKeyCode:65 };
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({type:'keyDown'}, keyA));
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({type:'keyUp'}, keyA));
        await wc.debugger.sendCommand('Input.insertText', {text:val});
        await sleepMs(150);
        const rv = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){ var el=document.elementFromPoint(${x},${y}); if(!el) return ''; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var q=el.querySelector('input,textarea'); if(q) el=q; else return ''; } return String(el.value); })()` });
        if (String((rv && rv.result && rv.result.value) || '') === val) { verified = true; mode = 'cdp-keyboard-top'; }
      } catch (_) {}
    }

    // 5) 只要没在 iframe 会话内派发、也没能确认值，就明确失败（v1.9.13 的假成功在此放行）
    if (!inFrameDone && !verified) {
      return { ok:false, error:'未能把分数送进 iframe（顶层派发未生效）。请点「自动识别元素」重新拾取', diag, hit };
    }
    const warn = verified ? '' : (note || '已在 iframe 会话内派发键盘事件，但读不到输入框的值，请在浏览器窗口确认分数');
    return { ok:true, hit: hit || 'iframe 内输入框', verified, mode, warn, note, diag };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    releaseIframeSessions(wc, sessions);
    if (attached) { try { wc.debugger.detach(); } catch (e2) { /* ignore */ } }
  }
});

/* ============ 自动识别：穿透跨域 iframe（v1.9.14） ============ */
// 顶层 querySelector / contentDocument 对 OOPIF 一律返回空，所以 17阅卷点「自动识别元素」
// 会报「分数输入框=未找到，提交按钮=未找到」。这里逐个 iframe session 执行识别脚本，
// 再把 iframe 内局部坐标换算成顶层窗口坐标交回渲染层。
ipcMain.handle('browser:cdp-detect-iframes', async () => {
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  const wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u); } catch (_) { return false; } }) || guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  let attached = false, sessions = [];
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    const rf = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){
      var a=[], fs=document.querySelectorAll('iframe,frame');
      for(var i=0;i<fs.length;i++){ var r=fs[i].getBoundingClientRect(); a.push({left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),src:fs[i].src||''}); }
      return JSON.stringify({frames:a, top:location.href});
    })()` });
    let fo = {}; try { fo = JSON.parse((rf && rf.result && rf.result.value) || '{}'); } catch (_) {}
    const frames = fo.frames || [];
    const col = await collectIframeSessions(wc, frames.map(f => f.src).join(' '));
    sessions = col.sessions;
    const results = [];
    for (const s of sessions) {
      try {
        const rr = await wc.debugger.sendCommand('Runtime.evaluate', { returnByValue:true, expression: `(function(){
          function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); return r.width>4&&r.height>4&&r.top>=-5&&r.left>=-5; }
          function tagOf(e){ return e.tagName+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+String(e.className).trim().split(/\\s+/).slice(0,2).join('.'):''); }
          function ctr(e){ var r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; }
          var score=null, cands=[], ins=document.querySelectorAll('input');
          for(var i=0;i<ins.length;i++){
            var el=ins[i], cl=String(el.className||''), ph=String(el.getAttribute&&el.getAttribute('placeholder')||'');
            if(!vis(el)) continue;
            var t=(el.type||'text').toLowerCase(); if(t!=='text'&&t!=='number') continue;
            if(/scale|zoom|percent/i.test(cl)||/[%％]/.test(ph)) continue;
            if(/score|scoreinput|得分|分数|el-input__inner/i.test(cl)){ score=el; break; }
            cands.push(el);
          }
          if(!score&&cands.length) score=cands[0];
          var sub=null, cs=document.querySelectorAll('div,button,span,a');
          function isSub(tx){ return tx==='提交'||/^(提交分数|提交评阅|确认提交|提交答卷|提交并继续|提交本题|评阅完成|提交并下一题)$/.test(tx); }
          for(var k=0;k<cs.length;k++){ var tx=(cs[k].textContent||'').replace(/\\s+/g,''); if(isSub(tx)&&vis(cs[k])){ sub=cs[k]; break; } }
          return JSON.stringify({r:'OK', isTop:(window.top===window.self), url:location.href, inputs:ins.length,
            score:score?Object.assign(ctr(score),{tag:tagOf(score)}):null,
            submit:sub?Object.assign(ctr(sub),{tag:tagOf(sub),text:String(sub.textContent||'').replace(/\\s+/g,'').slice(0,16)}):null});
        })()` }, s.sessionId);
        let d = {}; try { d = JSON.parse((rr && rr.result && rr.result.value) || '{}'); } catch (_) {}
        if (d.r === 'OK' && !d.isTop) { d.sessionUrl = s.url; d.rank = s.rank; results.push(d); }
      } catch (_) {}
    }
    return { ok:true, frames, results, diag: col.diag, top: fo.top || '' };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    releaseIframeSessions(wc, sessions);
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
