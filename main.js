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
ipcMain.handle('browser:cdp-fill-iframe', async (e, payload) => {
  const { x, y, value } = payload || {};
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  const wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u); } catch (_) { return false; } }) || guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  if (x == null || y == null) return { error: '缺少输入框坐标' };
  const val = String(value);
  if (!val) return { error: '缺少要填入的值' };
  const rbx = x, rby = y;
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    try { await wc.debugger.sendCommand('Page.bringToFront'); } catch (_) {}

    // 1) 顶层探针：沿 iframe 递归（同源可穿透），拿到 iframe src / 局部坐标 / 输入框标签
    const probe = await wc.debugger.sendCommand('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function(){
        function walk(doc, cx, cy, depth){
          var el = doc.elementFromPoint(cx, cy);
          if(!el) return {r:'NONE'};
          if((el.tagName==='IFRAME'||el.tagName==='FRAME') && depth<8){
            var r = el.getBoundingClientRect();
            var nx = cx - r.left, ny = cy - r.top;
            var idoc = null; try{ idoc = el.contentDocument; }catch(err){}
            if(idoc && el.contentWindow){
              var inner = walk(idoc, nx, ny, depth+1);
              if(inner && inner.r==='OK'){
                return {r:'OK', hit:inner.hit, inFrame:true, sameOrigin:true, src:el.src||'', ix:Math.round(nx), iy:Math.round(ny)};
              }
            }
            return {r:'CROSS', cross:true, src:el.src||'', ix:Math.round(nx), iy:Math.round(ny)};
          }
          if(el.tagName!=='INPUT' && el.tagName!=='TEXTAREA'){
            var i = el.querySelector('input, textarea');
            if(i) el = i; else return {r:'NOT_INPUT', hit:el.tagName};
          }
          return {r:'OK', hit:el.tagName+(el.id?'#'+el.id:''), inFrame:depth>0, sameOrigin:true, src:'', ix:Math.round(cx), iy:Math.round(cy)};
        }
        return walk(document, ${x}, ${y}, 0);
      })()`
    });
    const info = (probe && probe.result && probe.result.value) || {};
    const rbx2 = (info.ix != null ? info.ix : rbx);
    const rby2 = (info.iy != null ? info.iy : rby);

    // 2) 顶层派发真实鼠标点击（原始窗口坐标，浏览器自动路由进 iframe）
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleepMs(30);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleepMs(40);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    await sleepMs(160);

    // 3) Ctrl+A 全选 → Input.insertText（受信任输入，覆盖旧值）
    const keyA = { modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, keyA));
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, keyA));
    await sleepMs(60);
    await wc.debugger.sendCommand('Input.insertText', { text: val });
    await sleepMs(200);

    // 4) 回读验证：同源 iframe 可直接递归读；跨域用 CDP target 只读（放宽匹配）
    let verified = false, warn = '', hit = info.hit || '';
    try {
      const rr = await wc.debugger.sendCommand('Runtime.evaluate', {
        returnByValue: true,
        expression: `(function(){
          function walk(doc, cx, cy, depth){
            var el = doc.elementFromPoint(cx, cy); if(!el) return null;
            if((el.tagName==='IFRAME'||el.tagName==='FRAME') && depth<8){
              var r=el.getBoundingClientRect(), idoc=null;
              try{ idoc=el.contentDocument; }catch(err){}
              if(idoc) return walk(idoc, cx-r.left, cy-r.top, depth+1);
              return null;
            }
            if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; else return null; }
            return el;
          }
          var el = walk(document, ${x}, ${y}, 0);
          if(!el) return '';
          return JSON.stringify({v:el.value, tag:el.tagName+(el.id?'#'+el.id:'')});
        })()`
      });
      let o = {}; try { o = JSON.parse((rr && rr.result && rr.result.value) || '{}'); } catch (_) {}
      if (String(o.v) === val) { verified = true; hit = o.tag || hit; }
    } catch (_) {}

    // 4b) 跨域：遍历 CDP target 只读回读（不再要求 url 精确匹配 / attached===false）
    if (!verified) {
      try {
        const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets');
        const srcBase = String(info.src || '').split('#')[0];
        const srcPath = srcBase.split('?')[0];
        let origin = ''; try { origin = new URL(srcBase).origin; } catch (_) {}
        const rank = (t) => {
          const u = String(t.url || '');
          if (srcBase && (u === srcBase || u.startsWith(srcBase))) return 5;
          if (srcPath && u.split('?')[0] === srcPath) return 4;
          try { if (origin && new URL(u).origin === origin) return 3; } catch (_) {}
          return t.type === 'iframe' ? 2 : 1;
        };
        const all = (targetInfos || []).filter(t => (t.type === 'iframe' || t.type === 'page') && t.url && t.url !== 'about:blank');
        all.sort((a, b) => rank(b) - rank(a));
        for (const t of all.slice(0, 8)) {
          let sid = null;
          try {
            const at = await wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true });
            sid = at.sessionId;
            const rr = await wc.debugger.sendCommand('Runtime.evaluate', {
              returnByValue: true,
              expression: `(function(){ var ae=document.activeElement, el=ae; if(!el) return ''; if(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ el=document.elementFromPoint(${rbx2},${rby2}); if(el&&el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA'){ var i=el.querySelector('input,textarea'); if(i) el=i; } } if(!el||(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA')) return ''; return JSON.stringify({v:el.value, tag:el.tagName+(el.id?'#'+el.id:'')}); })()`
            }, sid);
            let o = {}; try { o = JSON.parse((rr && rr.result && rr.result.value) || '{}'); } catch (_) {}
            if (String(o.v) === val) { verified = true; hit = o.tag || hit; }
          } catch (_) {}
          finally { if (sid) { try { await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: sid }); } catch (_) {} } }
          if (verified) break;
        }
      } catch (_) {}
    }

    // 4c) 回读不到（跨域且无可用 target）：改用逐字符完整键盘链再输一遍；
    //     顶层 CDP 输入已派发，不因「读不到」而中断阅卷，只给 warn 提示人工确认。
    if (!verified) {
      try {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, keyA));
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, keyA));
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
        await sleepMs(60);
        for (const ch of val) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
          await sleepMs(30);
        }
        await sleepMs(120);
      } catch (_) {}
      warn = '无法回读 iframe 内输入框的值（已派发顶层键盘输入 + 逐字符键盘链，请在浏览器窗口确认）';
    }
    return { ok: true, hit: hit || 'iframe 内输入框', verified, mode: 'cdp-keyboard-top', inFrame: !!info.inFrame || !!info.cross, warn };
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
