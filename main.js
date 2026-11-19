const { app, BrowserWindow, Notification, shell, Menu, ipcMain, webContents, session } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const fs = require('node:fs');
const https = require('node:https');
const httpMod = require('node:http');

let mainWin = null;
let browserWin = null;

/* Windows 通知（Toast）必须设置 AppUserModelID，且与 electron-builder 的 appId 一致，
   否则通知发得出去但系统不显示（开发模式直接跑 electron.exe 时常踩这个）。 */
try { app.setAppUserModelId('com.yjai.reader'); } catch (_) {}

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

/* ============ 自动更新（自实现，双通道） ============ */
/*
   为什么弃用 electron-updater：
   1) 它用 Electron 的 net 模块（Chromium 网络栈）发请求，严格遵循系统代理。
      本机实测系统代理 127.0.0.1:7892 在运行，但对 github 下载域名直接拒绝连接，
      于是客户端永远只看到 net::ERR_CONNECTION_REFUSED，看起来像「GitHub 不可达」。
   2) 它必须严格按 latest.yml 的 feed 下载，镜像 302 跳转或响应慢一点就直接判失败。

   现在改成双通道（2026-11-17 本机实测数据）：
     通道A  系统代理 + GitHub 官方 CDN：手写 CONNECT 隧道，实测 0.91MB/s，82MB ≈ 90 秒
     通道B  公益镜像直连：每个连接被限速，实测 0.10~0.20MB/s，82MB 要 7~10 分钟
     通道C  手动下载：前两者都挂时，用浏览器打开镜像链接
   A 优先，失败自动降级到 B，进度全程可见。
*/
const GH_LATEST = 'https://github.com/HiMatrixor/YJAI/releases/latest/download';
/* 32 位（Windows 7）走独立的版本清单：latest-ia32.yml。
   两份清单指向各自的安装包，否则 32 位机器会下到 x64 包，装完直接打不开。 */
const FEED_FILE = process.arch === 'ia32' ? 'latest-ia32.yml' : 'latest.yml';
const UPDATE_MIRRORS = [
  'https://gh-proxy.net/' + GH_LATEST,
  'https://ghproxy.net/' + GH_LATEST,
  'https://ghfile.geekertao.top/' + GH_LATEST,
  GH_LATEST
];

/* ---------- 系统代理（Windows 上由 Clash / v2ray 等设置） ---------- */
let proxyCache;   // undefined=未探测，null=无代理，{host,port}=有代理
async function getSystemProxy() {
  if (proxyCache !== undefined) return proxyCache;
  try {
    const r = await session.defaultSession.resolveProxy('https://github.com');
    // 形如 "PROXY 127.0.0.1:7892;DIRECT" / "DIRECT"
    const m = /PROXY\s+([^;\s]+)/i.exec(String(r || ''));
    if (m) {
      const s = m[1];
      const i = s.lastIndexOf(':');
      const host = i > 0 ? s.slice(0, i) : s;
      const port = parseInt(i > 0 ? s.slice(i + 1) : '80', 10) || 80;
      if (host && port) { proxyCache = { host, port }; return proxyCache; }
    }
  } catch (_) {}
  proxyCache = null;
  return null;
}

/* ---------- 统一请求：直连或经代理，自动跟随重定向 ---------- */
function openStream(rawUrl, opts, proxy, redirectLeft) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(rawUrl); } catch (_) { return resolve({ err: '地址无效' }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : httpMod;
    const headers = Object.assign({ 'User-Agent': 'YJAI-Updater/3', 'Accept': '*/*' }, opts.headers || {});
    const idleTimeout = opts.timeout || 20000;

    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, rawUrl).href; } catch (_) { return resolve({ err: '重定向地址无效' }); }
        return openStream(next, opts, proxy, redirectLeft - 1).then(resolve);
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    };

    const doDirect = () => {
      const req = mod.request({
        host: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: Object.assign({}, headers, { Host: u.hostname }),
        servername: isHttps ? u.hostname : undefined
      }, handle);
      req.setTimeout(idleTimeout, () => { try { req.destroy(); } catch (_) {} resolve({ err: '连接超时' }); });
      req.on('error', (e) => resolve({ err: (e && e.code) || '网络错误' }));
      req.end(opts.body || undefined);
    };

    if (proxy && proxy.host && isHttps && !opts.noProxy) {
      let cr;
      try {
        cr = httpMod.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: u.hostname + ':443', timeout: idleTimeout });
      } catch (_) { return doDirect(); }
      cr.on('connect', (r, socket) => {
        if (r.statusCode !== 200) {
          try { socket.destroy(); } catch (_) {}
          return doDirect();   // 代理拒绝该域名 → 退回直连
        }
        const req = https.request({
          host: u.hostname, servername: u.hostname,
          path: u.pathname + u.search, method: opts.method || 'GET',
          headers, socket, agent: false, createConnection: () => socket
        }, handle);
        req.setTimeout(idleTimeout, () => { try { req.destroy(); } catch (_) {} resolve({ err: '连接超时' }); });
        req.on('error', (e) => resolve({ err: (e && e.code) || '网络错误' }));
        req.end(opts.body || undefined);
      });
      cr.on('timeout', () => { try { cr.destroy(); } catch (_) {} doDirect(); });
      cr.on('error', () => { try { cr.destroy(); } catch (_) {} doDirect(); });
      cr.end();
    } else {
      doDirect();
    }
  });
}

async function httpText(url, { timeout = 10000, proxy = null, headers } = {}) {
  const r = await openStream(url, { timeout, headers }, proxy, 6);
  if (r.err) return { ok: false, error: r.err };
  if (r.status !== 200 && r.status !== 206) {
    r.stream.resume();
    return { ok: false, status: r.status };
  }
  const text = await new Promise((resolve) => {
    let b = '';
    r.stream.setEncoding('utf8');
    r.stream.on('data', (d) => { if (b.length < 262144) b += d; });
    r.stream.on('end', () => resolve(b));
    r.stream.on('error', () => resolve(b));
  });
  return { ok: true, status: r.status, text };
}

function parseLatestYml(t) {
  return {
    version: (t.match(/^version:\s*([^\s]+)/m) || [])[1] || '',
    file: (t.match(/^path:\s*([^\s]+)/m) || [])[1] || '',
    sha512: (t.match(/^\s*sha512:\s*([^\s]+)/m) || [])[1] || ''
  };
}

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/* 探测可用通道：有代理时先单独给它 5 秒优先窗口（实测 1~3 秒返回），
   失败再并行探镜像。这样既快又不会被慢镜像拖住。 */
async function pickFeed() {
  const proxy = await getSystemProxy();
  if (proxy) {
    const got = await Promise.race([
      httpText(GH_LATEST + '/' + FEED_FILE, { timeout: 6000, proxy }),
      new Promise((res) => setTimeout(() => res(null), 5000))
    ]);
    if (got && got.ok && /^version:\s*\d/m.test(got.text || '')) {
      const info = parseLatestYml(got.text);
      if (info.version) return { base: GH_LATEST, info, proxy, label: '代理' };
    }
  }
  const tasks = UPDATE_MIRRORS.map((base) => ({ base, proxy: null, label: '镜像' }));
  return new Promise((resolve) => {
    let pending = tasks.length, settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    if (!tasks.length) return finish(null);
    tasks.forEach((t) => {
      httpText(t.base + '/' + FEED_FILE, { timeout: 10000, proxy: t.proxy })
        .then((r) => {
          if (!settled && r.ok && /^version:\s*\d/m.test(r.text || '')) {
            const info = parseLatestYml(r.text);
            if (info.version) return finish({ base: t.base, info, proxy: t.proxy, label: t.label });
          }
          if (--pending === 0) finish(null);
        })
        .catch(() => { if (--pending === 0) finish(null); });
    });
  });
}

function sendUpdate(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
  }
}

async function checkUpdate() {
  sendUpdate('update:status', { state: 'checking' });
  const pick = await pickFeed();
  if (!pick) {
    const msg = '连不上更新服务器：GitHub 直连与全部镜像均不可达。可点「手动下载」用浏览器获取安装包';
    sendUpdate('update:status', { state: 'error', message: msg });
    return { error: msg };
  }
  const cur = app.getVersion();
  if (cmpVer(pick.info.version, cur) > 0) {
    sendUpdate('update:status', { state: 'available', info: { version: pick.info.version }, mirror: pick.base, via: pick.label });
    return { ok: true, version: pick.info.version, current: cur, mirror: pick.base, via: pick.label };
  }
  sendUpdate('update:status', { state: 'none', info: { version: cur } });
  return { ok: true, version: cur, current: cur, none: true };
}
ipcMain.handle('update:version', () => ({ version: app.getVersion() }));

/* ---- 自实现下载：流式写入临时目录，支持多源失败切换 ---- */
let downloading = false;
let downloadedPath = '';

async function downloadFile(url, dest, onProgress, { proxy = null, timeout = 25000 } = {}) {
  const r = await openStream(url, { timeout }, proxy, 6);
  if (r.err) return { ok: false, error: r.err };
  const res = r.stream;
  if (r.status !== 200 && r.status !== 206) { res.resume(); return { ok: false, error: 'HTTP ' + r.status }; }
  const total = Number(r.headers['content-length'] || 0);
  let got = 0, lastTick = 0;
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const out = fs.createWriteStream(dest);
    res.on('data', (chunk) => {
      got += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 400) { lastTick = now; onProgress(got, total); }
    });
    res.on('error', (e) => { try { out.destroy(); } catch (_) {} done({ ok: false, error: (e && e.code) || '网络中断', partial: got }); });
    out.on('error', (e) => { try { res.destroy(); } catch (_) {} done({ ok: false, error: e.message }); });
    out.on('finish', () => { if (onProgress) onProgress(got, total || got); done({ ok: true, size: got }); });
    res.pipe(out);
  });
}

/* 下载策略：代理+官方 优先（实测快 5~10 倍），失败降级到镜像 */
async function doDownload() {
  if (downloading) return { ok: false, error: '正在下载中，请稍候' };
  downloading = true;
  try {
    const pick = await pickFeed();
    if (!pick) {
      const msg = '没有可用的下载源（GitHub 直连与全部镜像均不可达）';
      sendUpdate('update:status', { state: 'error', message: msg });
      return { ok: false, error: msg };
    }
    const info = pick.info;
    const name = info.file || ('YJAI-Setup-' + info.version + '.exe');
    const dest = path.join(app.getPath('temp'), name);

    const proxy = await getSystemProxy();
    // 候选顺序：代理+官方 → 直连官方 → 各镜像直连
    const tries = [];
    if (proxy) tries.push({ base: GH_LATEST, proxy, label: '代理加速' });
    tries.push({ base: GH_LATEST, proxy: null, label: '直连' });
    UPDATE_MIRRORS.forEach((m) => { if (m !== GH_LATEST) tries.push({ base: m, proxy: null, label: '镜像' }); });

    let lastErr = '';
    for (const t of tries) {
      try { fs.unlinkSync(dest); } catch (_) {}
      sendUpdate('update:status', { state: 'downloading', percent: 0, transferred: 0, total: 0, mirror: t.base, via: t.label });
      const r = await downloadFile(t.base + '/' + name, dest, (got, total) => {
        const percent = total ? Math.min(100, got * 100 / total) : 0;
        sendUpdate('update:status', { state: 'downloading', percent, transferred: got, total, mirror: t.base, via: t.label });
      }, { proxy: t.proxy });
      if (!r.ok) { lastErr = r.error; continue; }

      // 1) 必须是 PE 可执行文件，防止镜像返回的 HTML 错误页被当安装包启动
      let head = Buffer.alloc(2);
      try {
        const fd = fs.openSync(dest, 'r');
        fs.readSync(fd, head, 0, 2, 0);
        fs.closeSync(fd);
      } catch (_) {}
      if (head.toString() !== 'MZ') { lastErr = '下载到的不是安装包（来源返回异常内容）'; continue; }

      // 2) sha512 与 latest.yml 比对，防止半截文件
      if (info.sha512) {
        const h = crypto.createHash('sha512');
        h.update(fs.readFileSync(dest));
        if (h.digest('base64') !== info.sha512) { lastErr = '安装包校验不通过（下载可能不完整）'; continue; }
      }

      downloadedPath = dest;
      sendUpdate('update:status', { state: 'downloaded', version: info.version, path: dest, size: r.size, mirror: t.base, via: t.label });
      return { ok: true, version: info.version, path: dest, size: r.size, via: t.label };
    }
    const msg = '下载失败：' + (lastErr || '未知错误');
    sendUpdate('update:status', { state: 'error', message: msg });
    return { ok: false, error: msg };
  } finally {
    downloading = false;
  }
}

ipcMain.handle('update:check', async () => {
  try { return await checkUpdate(); }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('update:download', async () => {
  try { return await doDownload(); }
  catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('update:install', async () => {
  try {
    if (!downloadedPath || !fs.existsSync(downloadedPath)) return { error: '安装包不存在，请重新下载' };
    const r = await shell.openPath(downloadedPath);
    if (r) return { error: '启动安装程序失败：' + r };
    setTimeout(() => { try { app.quit(); } catch (_) {} }, 1500);
    setTimeout(() => { try { app.exit(0); } catch (_) {} }, 6000);
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});
// 手动下载兜底：镜像连不上/客户端下载失败时，直接用浏览器拉安装包
ipcMain.handle('update:manual', async () => {
  try {
    let name = '';
    try {
      const r = await httpText('https://api.github.com/repos/HiMatrixor/YJAI/releases/latest', { timeout: 8000 });
      if (r.ok) {
        const j = JSON.parse(r.text);
        const ex = (j && j.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
        if (ex) name = ex.name;
      }
    } catch (_) {}
    const pick = await pickFeed();
    const base = pick ? pick.base : '';
    if (!name && pick) name = pick.info.file || ('YJAI-Setup-' + pick.info.version + '.exe');
    const url = base ? (base + '/' + name) : ('https://github.com/HiMatrixor/YJAI/releases/latest');
    shell.openExternal(url);
    return { ok: true, url: url, mirrored: !!base };
  } catch (e) { return { error: String(e.message || e) }; }
});

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
/* ============ iframe 内分数框（v1.9.15：帧树 + 隔离世界） ============ */
// v1.9.14 走的是「attach iframe session」，但 17阅卷的 iframe 与顶层同站不同源（oss 与 web
// 子域），同一渲染进程 → 没有 iframe target，线上诊断 targets=3 里一个 iframe 都没有，
// sessions 只能 attach 到 page，整条路从第一步就走不通。现在改成：getFrameTree 找到帧 →
// createIsolatedWorld 进帧执行 → 语义定位输入框 → focus 后顶层键入 → 回读验证。
// 全程不依赖拾取坐标（换题/改版后坐标必失效）。
ipcMain.handle('browser:cdp-fill-iframe', async (e, payload) => {
  const { x, y, value } = payload || {};
  const val = String(value == null ? '' : value);
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  const wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u); } catch (_) { return false; } }) || guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  if (!val) return { error: '缺少要填入的值' };
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    try { await wc.debugger.sendCommand('Page.bringToFront'); } catch (_) {}

    const frames = await listFrames(wc);
    const diag = 'frames=' + frames.length + '[' + frames.slice(0, 6).map(f => f.depth + ':' + shortUrl(f.url)).join(' ') + ']';

    // 1) 逐帧语义定位（子帧优先，顶层兜底）。不依赖拾取坐标：换题/改版/缩放后坐标早就失效了。
    let hitFrame = null, hitCtx = null, hitInfo = null, worldFail = 0;
    const ordered = frames.filter(f => f.depth > 0).concat(frames.filter(f => f.depth === 0));
    for (const f of ordered) {
      let ctx = null;
      try { ctx = await openFrameWorld(wc, f.id, 'yjai_fill_' + f.depth); } catch (_) { ctx = null; }
      if (!ctx) { worldFail++; continue; }
      let info = null;
      try { info = JSON.parse(String((await evalCtx(wc, ctx, scoreFindExpr(x, y))) || '')); } catch (_) { info = null; }
      if (!info || info.r !== 'OK') continue;
      const better = !hitInfo
        || (hitInfo.isTop && !info.isTop)
        || (hitInfo.isTop === info.isTop && hitInfo.how !== 'class' && info.how === 'class');
      if (better) { hitFrame = f; hitCtx = ctx; hitInfo = info; }
      if (!info.isTop && info.how === 'class') break;
    }

    // 2) 一个输入框都没有：键盘给分型平台（或结构完全没识别到），按坐标敲数字
    if (!hitInfo) {
      if (x != null && y != null) {
        try {
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y });
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1, buttons: 1 });
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1, buttons: 0 });
          await sleepMs(160);
          for (const ch of val) {
            const vk = ch.charCodeAt(0);
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
            await sleepMs(40);
          }
          return { ok: true, verified: false, mode: 'keyboard-coord', hit: '给分点坐标', warn: '页面内没有可填写的输入框，已按「键盘给分」在坐标处派发数字键，请在浏览器窗口确认', diag: diag };
        } catch (_) {}
      }
      return { ok: false, error: '页面内未找到分数输入框（已扫描 ' + frames.length + ' 个 frame，' + worldFail + ' 个无法建立上下文），请确认阅卷页面已打开且题目处于可评分状态', diag: diag };
    }

    // 3) 聚焦 + 清空 → 顶层派发受信任文本输入（键盘按焦点投递，同进程子帧能收到）
    const ctx = hitCtx;
    let verified = false, mode = '', note = '';
    try {
      const focused = await evalCtx(wc, ctx, `(function(){
        var el=window.__yjaiEl; if(!el) return 'NO_EL';
        try{ el.scrollIntoView({block:'center'}); }catch(e){}
        try{ el.focus(); }catch(e){}
        try{ el.select && el.select(); }catch(e){}
        var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
        if(setter) setter.call(el,''); else el.value='';
        try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}
        return (document.activeElement===el) ? 'FOCUSED' : ('NOT_FOCUSED:'+String(document.activeElement&&document.activeElement.tagName));
      })()`);
      await wc.debugger.sendCommand('Input.insertText', { text: val });
      await sleepMs(170);
      const v1 = await evalCtx(wc, ctx, `(function(){ var el=window.__yjaiEl; return el?String(el.value==null?'':el.value):''; })()`);
      if (String(v1 == null ? '' : v1) === val) { verified = true; mode = 'frame-keyboard'; }
      else if (focused !== 'FOCUSED') { note = 'iframe 内输入框未获得焦点（' + String(focused) + '）'; }
    } catch (e2) { note = 'iframe 内键盘输入异常: ' + String(e2 && e2.message || e2).slice(0, 80); }

    // 4) 键盘没吃下（受控组件拦截 / 输入法）：逐字符再敲一遍
    if (!verified) {
      try {
        await evalCtx(wc, ctx, `(function(){ var el=window.__yjaiEl; if(!el) return ''; try{ el.focus(); }catch(e){} return 'OK'; })()`);
        for (const ch of val) {
          const vk = ch.charCodeAt(0);
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
          await sleepMs(45);
        }
        await sleepMs(130);
        const v2 = await evalCtx(wc, ctx, `(function(){ var el=window.__yjaiEl; return el?String(el.value==null?'':el.value):''; })()`);
        if (String(v2 == null ? '' : v2) === val) { verified = true; mode = 'frame-keyboard-chars'; }
      } catch (_) {}
    }

    // 5) 仍不行：原生 setter + input/change 显式通知 Vue（受控组件最后一条路）
    if (!verified) {
      try {
        const v3 = await evalCtx(wc, ctx, `(function(){
          var el=window.__yjaiEl, v=${JSON.stringify(val)}; if(!el) return '';
          var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
          if(setter) setter.call(el,v); else el.value=v;
          try{ el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v})); }
          catch(e){ try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e2){} }
          try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
          return String(el.value==null?'':el.value);
        })()`);
        if (String(v3 == null ? '' : v3) === val) { verified = true; mode = 'frame-dom-setter'; }
      } catch (_) {}
    }

    const hitTx = (hitInfo.hit || '分数输入框') + (hitFrame && hitFrame.depth > 0 ? (' @iframe(' + shortUrl(hitFrame.url) + ')') : ' @top');
    if (!verified) {
      return { ok: false, error: '分数输入框已定位（' + hitTx + '）但输入未生效', hit: hitTx, mode: mode || 'none', note: note, diag: diag };
    }
    return { ok: true, verified: true, mode: mode, hit: hitTx, note: note, diag: diag };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e2) { /* ignore */ } }
  }
});
/* ============ 自动识别：穿透 iframe（v1.9.15 帧树版） ============ */
// 顶层 querySelector / contentDocument 对跨源 iframe 一律为空，所以 17阅卷点「自动识别元素」
// 会报「分数输入框=未找到，提交按钮=未找到」。这里逐帧用隔离世界执行识别脚本，
// 再把帧内局部坐标 + 顶层 iframe 偏移换算成窗口坐标交回渲染层。
ipcMain.handle('browser:cdp-detect-iframes', async () => {
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  const wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u); } catch (_) { return false; } }) || guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    const frames = await listFrames(wc);
    const diag = 'frames=' + frames.length + '[' + frames.slice(0, 6).map(f => f.depth + ':' + shortUrl(f.url)).join(' ') + ']';
    const results = [];
    for (const f of frames) {
      let ctx = null;
      try { ctx = await openFrameWorld(wc, f.id, 'yjai_det_' + f.depth); } catch (_) { continue; }
      if (!ctx) continue;
      let d = null;
      try { d = JSON.parse(String((await evalCtx(wc, ctx, detectFrameExpr())) || '')); } catch (_) { d = null; }
      if (!d || !d.url) continue;
      if (!d.score && !d.submit) continue;
      results.push({ url: d.url, depth: f.depth, isTop: !!d.isTop, score: d.score, submit: d.submit, off: { x: 0, y: 0 } });
    }
    // 顶层直接子 iframe 的窗口偏移（一级足够；嵌套子帧由 depth 排序，坐标只用于日志与兜底）
    let topFrames = [];
    try {
      const topCtx = frames.length ? await openFrameWorld(wc, frames[0].id, 'yjai_top') : null;
      const raw = topCtx ? await evalCtx(wc, topCtx, `(function(){
        var a=[], fs=document.querySelectorAll('iframe,frame');
        for(var i=0;i<fs.length;i++){ var r=fs[i].getBoundingClientRect(); a.push({left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),src:fs[i].src||''}); }
        return JSON.stringify(a);
      })()`) : '[]';
      topFrames = JSON.parse(String(raw || '[]'));
    } catch (_) { topFrames = []; }
    const keyOf = (s) => { try { const u = new URL(s); return u.origin + u.pathname; } catch (_) { return String(s || '').split('#')[0].split('?')[0]; } };
    for (const it of results) {
      if (it.isTop) { it.off = { x: 0, y: 0 }; continue; }
      let f = topFrames.find(t => keyOf(t.src) === keyOf(it.url));
      if (!f) f = topFrames.find(t => { try { return new URL(t.src).origin === new URL(it.url).origin; } catch (_) { return false; } });
      if (!f && topFrames.length === 1) f = topFrames[0];
      it.off = f ? { x: f.left, y: f.top } : { x: 0, y: 0 };
    }
    return { ok: true, frames: frames.map(f => ({ depth: f.depth, url: f.url })), results: results, diag: diag, top: frames[0] ? frames[0].url : '' };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (_) {} }
  }
});
/* ============ 帧树内操作（v1.9.15） ============ */
// 17阅卷的 webview 顶层是 oss.17yuejuan.cn，打分板 iframe 是 web.17yuejuan.cn —— 同站不同源，
// 同一渲染进程，Target.getTargets 里根本没有 iframe target（线上诊断只有 page/page/webview），
// v1.9.14 的「attach iframe session」在这类平台上永远抓不到；顶层 Input 又依赖早已失效的坐标。
// 可靠路径：Page.getFrameTree 拿全部 frame（含跨域子帧）→ Page.createIsolatedWorld 在该帧
// 建隔离世界执行 JS（CDP 不受同源策略限制）→ 语义定位元素 → el.focus() 后由顶层
// Input.insertText 键入（键盘按焦点投递，同进程子帧能收到）→ 回该帧回读 el.value 验证。
async function listFrames(wc) {
  const frames = [];
  try { await wc.debugger.sendCommand('Page.enable'); } catch (_) {}
  let tree = null;
  try { const r = await wc.debugger.sendCommand('Page.getFrameTree'); tree = r && r.frameTree; } catch (_) {}
  const walk = (node, depth, parentId) => {
    if (!node || !node.frame) return;
    const f = node.frame;
    frames.push({ id: f.id, parentId: parentId || null, url: String(f.url || ''), name: f.name || '', origin: f.securityOrigin || '', depth: depth });
    (node.childFrames || []).forEach(c => walk(c, depth + 1, f.id));
  };
  walk(tree, 0, null);
  return frames;
}
async function openFrameWorld(wc, frameId, worldName) {
  const r = await wc.debugger.sendCommand('Page.createIsolatedWorld', { frameId: frameId, worldName: worldName || 'yjai_world', grantUniveralAccess: true });
  return (r && r.executionContextId) || null;
}
async function evalCtx(wc, ctxId, expression) {
  const r = await wc.debugger.sendCommand('Runtime.evaluate', { contextId: ctxId, returnByValue: true, expression: expression });
  if (r && r.exceptionDetails) return undefined;
  return r && r.result ? r.result.value : undefined;
}
function shortUrl(u) {
  const s = String(u || '').split('#')[0].split('?')[0].replace(/^https?:\/\//, '');
  if (!s) return 'about:blank';
  return s.length > 46 ? (s.slice(0, 46) + '…') : s;
}
function scoreFindExpr(hintX, hintY) {
  const hx = (typeof hintX === 'number' && isFinite(hintX)) ? Math.round(hintX) : -1;
  const hy = (typeof hintY === 'number' && isFinite(hintY)) ? Math.round(hintY) : -1;
  return `(function(){
    function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); return r.width>4 && r.height>4; }
    function tagOf(e){ var c=(e.className&&typeof e.className==='string')?e.className:''; return e.tagName+(e.id?'#'+e.id:'')+(c?'.'+String(c).trim().split(/\\s+/).slice(0,2).join('.'):''); }
    function asInput(e){ if(!e) return null; if(e.tagName==='INPUT'||e.tagName==='TEXTAREA') return e; if(e.querySelector){ var q=e.querySelector('input,textarea'); if(q) return q; } return null; }
    var best=null, how='', hx=${hx}, hy=${hy};
    if(hx>=0 && hy>=0){ var he=null; try{ he=asInput(document.elementFromPoint(hx,hy)); }catch(err){} if(he && vis(he) && !he.disabled && !he.readOnly){ best=he; how='point'; } }
    if(!best){
      var ins=document.querySelectorAll('input,textarea'), fill=[];
      for(var i=0;i<ins.length;i++){
        var el=ins[i]; if(!vis(el)||el.disabled||el.readOnly) continue;
        var t=String(el.type||'text').toLowerCase();
        if(el.tagName!=='TEXTAREA' && t!=='text' && t!=='number' && t!=='tel') continue;
        var cl=String(el.className||'')+' '+String((el.getAttribute&&el.getAttribute('placeholder'))||'');
        if(/scale|zoom|percent|[%％]/i.test(cl)) continue;
        if(/score|fenshu|mark|得分|分数|分值/i.test(cl)){ best=el; how='class'; break; }
        fill.push(el);
      }
      if(!best && fill.length){ best=fill[0]; how='first'; }
    }
    window.__yjaiEl = best;
    if(!best) return JSON.stringify({r:'NO_INPUT', inputs:document.querySelectorAll('input,textarea').length, url:location.href, isTop:(window.top===window.self)});
    var rb=best.getBoundingClientRect();
    return JSON.stringify({r:'OK', hit:tagOf(best), how:how, x:Math.round(rb.left+rb.width/2), y:Math.round(rb.top+rb.height/2), value:String(best.value==null?'':best.value), url:location.href, isTop:(window.top===window.self), inputs:document.querySelectorAll('input,textarea').length});
  })()`;
}
/* ============ 回车提交（v1.9.17） ============ */
// 17阅卷 / e卷通的评分面板根本没有「提交」按钮：分数框绑的是 @keyup.enter，
// 人工在框里敲一下回车就把这份交上去了（用户实测）。所以提交优先走「回车」，
// 按钮点击只作为没有分数框的平台的后备方案。
function enterTargetExpr() {
  return `(function(){
    function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); if(r.width<4||r.height<4) return false; var s=null; try{ s=getComputedStyle(e); }catch(err){} if(!s) return true; return !(s.visibility==='hidden'||s.display==='none'); }
    function tagOf(e){ var c=(e.className&&typeof e.className==='string')?e.className:''; return e.tagName+(e.id?'#'+e.id:'')+(c?'.'+String(c).trim().split(/\\s+/).slice(0,2).join('.'):''); }
    function norm(t){ return String(t==null?'':t).replace(/[\\s\\u00a0\\u3000]+/g,''); }
    var ins=document.querySelectorAll('input,textarea'), pick=null, pickS=0, cands=[];
    for(var i=0;i<ins.length;i++){
      var el=ins[i];
      if(!vis(el)||el.disabled||el.readOnly) continue;
      var t=String(el.type||'text').toLowerCase();
      if(el.tagName!=='TEXTAREA' && t!=='text' && t!=='number' && t!=='tel') continue;
      var key=String(el.className||'')+' '+String(el.id||'')+' '+String(el.getAttribute&&el.getAttribute('placeholder')||'')+' '+String(el.getAttribute&&el.getAttribute('name')||'');
      if(/search|keyword|filter|query|搜索|筛选|检索/i.test(key)) continue;   // 别把回车敲进搜索框
      var v=norm(el.value), s=0;
      if(/correct_custom_score|score-input|score_input|scoreinput/i.test(key)) s=14;
      else if(/score|fenshu|mark|得分|分数|分值|评阅/i.test(key)) s=9;
      if(!s){ if(cands.length<8) cands.push(tagOf(el)+'="'+v.slice(0,8)+'"'); continue; }
      if(!v) s-=6;                     // 空值不像「刚填过分」的那个框
      if(s>pickS){ pick=el; pickS=s; }
    }
    window.__yjaiEnter=null;
    if(!pick) return JSON.stringify({r:'NO_INPUT', url:location.href, isTop:(window.top===window.self), cands:cands.join('|')});
    try{ pick.scrollIntoView({block:'center'}); }catch(e){}
    try{ pick.focus(); }catch(e){}
    try{ var L=String(pick.value||'').length; pick.setSelectionRange(L,L); }catch(e){}
    window.__yjaiEnter=pick;
    return JSON.stringify({r:'OK', hit:tagOf(pick), value:norm(pick.value), focused:(document.activeElement===pick), url:location.href, isTop:(window.top===window.self)});
  })()`;
}
// 回车之后回头看一眼：框没了 / 被隐藏 / 值被清空，都说明平台已经收下并翻到下一份
function afterEnterExpr() {
  return `(function(){
    var el=window.__yjaiEnter, ex=false, v='', hid=true;
    try{ ex = !!(el && el.isConnected && document.documentElement.contains(el)); }catch(e){ ex=false; }
    if(ex){
      try{ v=String(el.value==null?'':el.value); }catch(e){}
      try{ var r=el.getBoundingClientRect(); hid = !r || r.width<4 || r.height<4; }catch(e){ hid=true; }
    }
    return JSON.stringify({exists:ex, hidden:hid, value:v, url:location.href});
  })()`;
}
async function pressEnter(wc) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  try { await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base)); } catch (_) {}
  try { await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r', unmodifiedText: '\r' }, base)); } catch (_) {}
  try { await wc.debugger.sendCommand('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base)); } catch (_) {}
}
function submitFindExpr() {
  // v1.9.16：各平台的提交按钮文字不统一（「提交分数」「提交批改」「确认批阅」「保存并下一位」…），
  // 精确白名单太容易漏。改成「按语义打分 + 可点击性过滤 + 黑名单排除」，并且找不到时把候选打回日志。
  return `(function(){
    function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); if(r.width<8||r.height<8) return false; var s=null; try{ s=getComputedStyle(e); }catch(err){} if(!s) return true; if(s.visibility==='hidden'||s.display==='none'||s.pointerEvents==='none') return false; if(String(s.opacity)==='0') return false; return true; }
    function tagOf(e){ var c=(e.className&&typeof e.className==='string')?e.className:''; return e.tagName+(e.id?'#'+e.id:'')+(c?'.'+String(c).trim().split(/\\s+/).slice(0,2).join('.'):''); }
    function depth(e){ var d=0,p=e; while(p&&p.parentElement){ d++; p=p.parentElement; } return d; }
    function norm(t){ return String(t==null?'':t).replace(/[\\s\\u00a0\\u3000]+/g,''); }
    function cls(e){ return (e.className&&typeof e.className==='string')?e.className:''; }
    function clickable(e){
      var tag=e.tagName;
      if(tag==='BUTTON') return true;
      if(tag==='A') return true;
      if(e.getAttribute&&String(e.getAttribute('role')||'')==='button') return true;
      if(e.hasAttribute&&e.hasAttribute('onclick')) return true;
      if(/btn|button|submit|confirm/i.test(cls(e)+' '+String(e.id||''))) return true;
      try{ if(getComputedStyle(e).cursor==='pointer') return true; }catch(err){}
      return false;
    }
    // 「满分 / 零分」与「提交分数」常共用 span.set-btn，误点一次就直接给满分 —— 黑名单优先
    var BAD=/满分|零分|取消|关闭|清空|重置|重做|返回|上一步|上一份|上一题|删除|撤销|收藏|批注|标记|切换|展开|收起|回退|自动/;
    function scoreOf(e,tx){
      if(!tx||tx.length>12) return 0;
      if(BAD.test(tx)) return 0;
      var key=cls(e)+' '+String(e.id||'');
      if(/提交/.test(tx)) return 12;
      if(/submit|confirm|tijiao/i.test(key)) return 11;
      if(/^(确认|确定)/.test(tx)) return 8;
      if(/确认|保存|完成/.test(tx)) return 6;
      if(/^(下一位|下一份|下一题|下个)/.test(tx)) return 5;
      return 0;
    }
    var list=document.querySelectorAll('button,a,span,div,li,input[type=button],input[type=submit]'), best=null, bestS=0;
    var relC=[], btnNames=[];
    for(var i=0;i<list.length;i++){
      var e=list[i];
      if(!vis(e)) continue;
      var dis=!!(e.disabled || (e.getAttribute&&String(e.getAttribute('aria-disabled'))==='true'));
      var tx=norm(e.tagName==='INPUT'?(e.value||''):e.textContent);
      if(!tx && e.getAttribute){ tx=norm(e.getAttribute('title')||e.getAttribute('aria-label')||''); }  // 图标按钮
      if(!tx||tx.length>14) continue;
      if(btnNames.length<16 && (e.tagName==='BUTTON'||/btn|button/i.test(cls(e)))) btnNames.push(tx.slice(0,10));
      var s=scoreOf(e,tx);
      if(!s) continue;
      if(!clickable(e)) continue;
      if(relC.length<10) relC.push(tagOf(e)+'='+tx.slice(0,12)+(dis?'(disabled)':''));
      if(dis) continue;                                          // 禁用的提交按钮不能点，但必须记录进候选
      var r=e.getBoundingClientRect();
      if(r.top>=-2 && r.bottom<=window.innerHeight+2) s+=0.5;   // 视口内优先（提交常在底部固定栏）
      if(!best || s>bestS || (s===bestS && depth(e)>depth(best))){ best=e; bestS=s; }
    }
    window.__yjaiSub=best;
    if(!best){
      var cand=relC.length?relC.join('|'):('BUTTONS['+btnNames.join('|')+']');
      return JSON.stringify({r:'NO_SUBMIT', url:location.href, isTop:(window.top===window.self), cands:cand});
    }
    var rb=best.getBoundingClientRect();
    return JSON.stringify({r:'OK', hit:tagOf(best), text:norm(best.textContent).slice(0,14), x:Math.round(rb.left+rb.width/2), y:Math.round(rb.top+rb.height/2), url:location.href, isTop:(window.top===window.self)});
  })()`;
}
function detectFrameExpr() {
  return `(function(){
    function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); if(r.width<6||r.height<6) return false; var s=null; try{ s=getComputedStyle(e); }catch(err){} return !s || (s.visibility!=='hidden' && s.display!=='none'); }
    function tagOf(e){ var c=(e.className&&typeof e.className==='string')?e.className:''; return e.tagName+(e.id?'#'+e.id:'')+(c?'.'+String(c).trim().split(/\\s+/).slice(0,2).join('.'):''); }
    function ctr(e){ var r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; }
    function depth(e){ var d=0,p=e; while(p&&p.parentElement){ d++; p=p.parentElement; } return d; }
    function isSub(tx){ return !!tx && tx.length<=12 && !/满分|零分|取消|关闭|清空|重置|重做|返回|上一步|上一份|上一题|删除|撤销|收藏|批注|标记|切换|自动/.test(tx) && /提交|确认|确定|保存|完成|下一位|下一份|下一题|下个/.test(tx); }
    var score=null, fill=[], ins=document.querySelectorAll('input,textarea');
    for(var i=0;i<ins.length;i++){
      var el=ins[i]; if(!vis(el)||el.disabled||el.readOnly) continue;
      var t=String(el.type||'text').toLowerCase();
      if(el.tagName!=='TEXTAREA' && t!=='text' && t!=='number' && t!=='tel') continue;
      var cl=String(el.className||'')+' '+String((el.getAttribute&&el.getAttribute('placeholder'))||'');
      if(/scale|zoom|percent|[%％]/i.test(cl)) continue;
      if(/score|fenshu|mark|得分|分数|分值/i.test(cl)){ score=el; break; }
      fill.push(el);
    }
    if(!score && fill.length) score=fill[0];
    var sub=null, list=document.querySelectorAll('button,span,a,li,div');
    for(var k=0;k<list.length;k++){
      var e2=list[k], tx=String(e2.textContent||'').replace(/\\s+/g,'');
      if(!isSub(tx)||!vis(e2)) continue;
      if(!sub || depth(e2)>depth(sub)) sub=e2;
    }
    return JSON.stringify({r:'OK', url:location.href, isTop:(window.top===window.self),
      score: score?Object.assign(ctr(score),{tag:tagOf(score)}):null,
      submit: sub?Object.assign(ctr(sub),{tag:tagOf(sub),text:String(sub.textContent||'').replace(/\\s+/g,'').slice(0,14)}):null});
  })()`;
}

/* ============ iframe 内提交按钮：语义定位 + DOM 点击（v1.9.15） ============ */
// 提交按钮同样在 frame 里，且「提交分数 / 满分 / 零分」常共用 span.set-btn —— 按坐标点一旦
// 偏了就会点成「满分」（v1.9.10 的事故）。这里按文字语义精确定位到元素本身再点，杜绝误点。
ipcMain.handle('browser:cdp-submit', async () => {
  const guests = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview');
  const wc = guests.find(w => { try { const u = w.getURL(); return u && !/^about:blank/.test(u); } catch (_) { return false; } }) || guests[0] || null;
  if (!wc || wc.isDestroyed()) return { error: '未找到浏览器页面（webview）' };
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    try { await wc.debugger.sendCommand('Page.bringToFront'); } catch (_) {}
    const frames = await listFrames(wc);
    const diag = 'frames=' + frames.length + '[' + frames.map(f => f.depth + ':' + shortUrl(f.url)).join(' ') + ']';
    const ordered = frames.filter(f => f.depth > 0).concat(frames.filter(f => f.depth === 0));
    const notFound = [];
    // ---------- 阶段 1：回车提交（17阅卷 / e卷通没有提交按钮，分数框绑的是 keyup.enter）----------
    for (const f of ordered) {
      let ctx = null;
      try { ctx = await openFrameWorld(wc, f.id, 'yjai_ent_' + f.depth); } catch (_) { continue; }
      if (!ctx) continue;
      let info = null;
      try { info = JSON.parse(String((await evalCtx(wc, ctx, enterTargetExpr())) || '')); } catch (_) { info = null; }
      if (!info || info.r !== 'OK') {
        if (info && info.cands) notFound.push('d' + f.depth + ':' + info.cands);
        continue;
      }
      await pressEnter(wc);
      await new Promise(r => setTimeout(r, 420));
      let after = null;
      try { after = JSON.parse(String((await evalCtx(wc, ctx, afterEnterExpr())) || '')); } catch (_) { after = null; }
      const submitted = !!after && (!after.exists || after.hidden || String(after.value) !== String(info.value));
      return {
        ok: true, mode: 'enter', hit: 'ENTER @' + (f.depth > 0 ? 'iframe(' + shortUrl(f.url) + ')' : 'top'),
        text: '回车提交', value: info.value, focused: !!info.focused, submitted: submitted, after: after,
        diag: diag, cands: notFound.join(' || ')
      };
    }
    // ---------- 阶段 2：语义按钮点击（没有分数框、只能点按钮的平台）----------
    for (const f of ordered) {
      let ctx = null;
      try { ctx = await openFrameWorld(wc, f.id, 'yjai_sub_' + f.depth); } catch (_) { continue; }
      if (!ctx) continue;
      let info = null;
      try { info = JSON.parse(String((await evalCtx(wc, ctx, submitFindExpr())) || '')); } catch (_) { info = null; }
      if (!info || info.r !== 'OK') {
        if (info && info.cands) notFound.push('d' + f.depth + ':' + info.cands);
        continue;
      }
      let dispatched = '';
      try {
        dispatched = String((await evalCtx(wc, ctx, `(function(){
          var el=window.__yjaiSub; if(!el) return 'NO_EL';
          try{ el.scrollIntoView({block:'center'}); }catch(e){}
          var r=el.getBoundingClientRect(), cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
          var opt={bubbles:true,cancelable:true,composed:true,clientX:cx,clientY:cy,button:0,buttons:1};
          try{ el.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerType:'mouse'},opt))); }catch(e){}
          try{ el.dispatchEvent(new MouseEvent('mousedown',opt)); }catch(e){}
          try{ el.dispatchEvent(new PointerEvent('pointerup',Object.assign({pointerType:'mouse'},opt,{buttons:0}))); }catch(e){}
          try{ el.dispatchEvent(new MouseEvent('mouseup',Object.assign({},opt,{buttons:0}))); }catch(e){}
          try{ el.click(); }catch(e){ return 'CLICK_ERR:'+e.message; }
          return 'OK';
        })()`)) || '');
      } catch (_) {}
      return { ok: true, hit: (info.hit || '提交按钮') + (f.depth > 0 ? (' @iframe(' + shortUrl(f.url) + ')') : ' @top'), text: info.text || '', mode: 'dom-click', dispatched: dispatched, diag: diag };
    }
    return { ok: false, error: 'NOT_FOUND', diag: diag, cands: notFound.join(' || ') };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (_) {} }
  }
});

/* ============ 结束提醒（电脑通知 + PushPlus 微信） ============ */
/*
   设计要点：
   1) 通知只在阅卷收尾时发一次，由渲染进程判定「完成 / 中断」后调过来，主进程不再判断业务。
   2) 手机推送必须走 node:https 直连（失败再降级到系统代理），不能用渲染进程 fetch：
      本机系统代理会劫持 Chromium 网络栈，之前自动更新就是这么被拖死的。
   3) 推送失败只回传错误给界面记日志，绝不抛异常影响阅卷收尾。
*/
function readAllText(stream, limit = 65536) {
  return new Promise((resolve) => {
    let b = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => { if (b.length < limit) b += d; });
    stream.on('end', () => resolve(b));
    stream.on('error', () => resolve(b));
  });
}

async function postJson(rawUrl, obj, { timeout = 12000 } = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Accept': 'application/json'
  };
  const attempt = async (proxy, noProxy) => {
    const r = await openStream(rawUrl, { method: 'POST', body, headers, timeout, noProxy }, proxy, 4);
    if (r.err) return { ok: false, error: r.err };
    const text = await readAllText(r.stream);
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, error: 'HTTP ' + r.status + (text ? ' ' + text.slice(0, 120) : '') };
    }
    return { ok: true, status: r.status, text };
  };
  let r = await attempt(null, true);          // 国内推送服务直连即可
  if (!r.ok) {
    const proxy = await getSystemProxy();     // 公司网络等必须走代理时才用得上
    if (proxy) {
      const r2 = await attempt(proxy, false);
      if (r2.ok) return r2;
      r = { ok: false, error: r.error + ' / 代理：' + r2.error };
    }
  }
  return r;
}

async function pushPlusSend(token, title, content) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: '未填写 PushPlus token' };
  const r = await postJson('https://www.pushplus.plus/send', {
    token: t,
    title: String(title || 'YJAI 提醒').slice(0, 100),
    content: String(content || ''),
    template: 'txt'
  }, { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error };
  let j = null;
  try { j = JSON.parse(r.text); } catch (_) {}
  if (!j) return { ok: false, error: '返回内容无法解析：' + String(r.text || '').slice(0, 80) };
  if (Number(j.code) === 200) return { ok: true };
  return { ok: false, error: j.msg || ('错误码 ' + j.code) };
}

/* 电脑端：系统通知 + 提示音 + 任务栏闪烁，三件一起上。
   原因：Windows「专注助手」会吞掉 Toast，只靠通知很可能静悄悄地什么也没有。 */
function notifyDesktop(p) {
  const opts = (p && p.opts) || {};
  let shown = false;
  try {
    if (opts.desktop !== false && Notification.isSupported()) {
      const n = new Notification({
        title: String((p && p.title) || 'YJAI'),
        body: String((p && p.body) || ''),
        silent: true   // 声音统一在下面播，避免被系统的通知静音策略连带掐掉
      });
      n.on('click', () => {
        try {
          if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.restore(); mainWin.focus(); }
        } catch (_) {}
      });
      n.show();
      shown = true;
    }
  } catch (_) {}
  if (opts.sound !== false) {
    try {
      shell.beep();
      setTimeout(() => { try { shell.beep(); } catch (_) {} }, 420);
    } catch (_) {}
  }
  if (opts.flash !== false && mainWin && !mainWin.isDestroyed() && !mainWin.isFocused()) {
    try {
      mainWin.flashFrame(true);
      setTimeout(() => { try { mainWin.flashFrame(false); } catch (_) {} }, 15000);
    } catch (_) {}
  }
  return shown;
}

async function sendNotify(p) {
  const payload = p || {};
  const opts = payload.opts || {};
  const out = { desktop: false, push: null };
  out.desktop = notifyDesktop(payload);
  const pp = opts.pushplus || {};
  if (pp.enabled) out.push = await pushPlusSend(pp.token, payload.title, payload.body);
  return out;
}

ipcMain.handle('notify:done', (e, p) => {
  return sendNotify(p).catch((err) => ({ desktop: false, push: { ok: false, error: String(err && err.message || err) } }));
});

ipcMain.handle('notify:test', (e, p) => {
  const opts = (p && p.opts) || {};
  const title = 'YJAI 提醒测试';
  const body = '能收到这条，说明提醒通道已打通。\n发送时间：' + new Date().toLocaleString('zh-CN');
  return sendNotify({ title, body, opts })
    .then((r) => {
      if (!r.push) r.push = { ok: false, error: '未启用手机提醒或未填写 token' };
      return r;
    })
    .catch((err) => ({
      desktop: false,
      push: { ok: false, error: String(err && err.message || err) }
    }));
});

/* —— 阅卷截图留档 ——
   只在评分失败 / 截错题这类异常时由渲染进程调用一次，平时不落盘，避免每份都写文件。
   文件写到 userData/shots，保留最近 300 张。 */
function shotsDir() {
  const dir = path.join(app.getPath('userData'), 'shots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

ipcMain.handle('shot:save', (e, p) => {
  try {
    const dataUrl = String((p && p.dataUrl) || '');
    const m = /^data:image\/(\w+);base64,(.*)$/.exec(dataUrl);
    if (!m) return { ok: false, error: '不是图片数据' };
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const dir = shotsDir();
    const t = new Date();
    const stamp = t.getFullYear() + String(t.getMonth() + 1).padStart(2, '0') + String(t.getDate()).padStart(2, '0')
      + '-' + String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0') + String(t.getSeconds()).padStart(2, '0');
    const name = stamp + '_' + String((p && p.no) || 0).padStart(2, '0') + '.' + ext;
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    try {
      const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
      const drop = files.length - 300;
      if (drop > 0) for (const f of files.slice(0, drop)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    } catch (_) {}
    return { ok: true, file, dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 启动后延迟自动检查更新（仅打包环境生效）：走镜像选源
  // 启动后延迟自动检查更新（静默，不打断用户）
  setTimeout(() => { checkUpdate().catch(() => {}); }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
