/* 构建 32 位（Windows 7）安装包。
   两个坑：
   1) package.json 的 win.target 声明了 x64，直接加 --ia32 会取并集，
      打出一个 ia32+x64 的双架构包（140MB），64 位机器上会装成 Electron 22。
      必须用 electron-builder 的 `nsis:ia32` 目标语法才能只打 ia32。
   2) Electron 22.3.27 是最后一个支持 Windows 7/8 的大版本，所以要显式指定；
      x64 包仍然用 package.json 里声明的 Electron 31。 */
const { spawnSync } = require('child_process');
const path = require('path');

const cli = require.resolve('electron-builder/out/cli/cli.js');
// 输出目录可用 YJAI_OUT 覆盖：旧目录里的 app.asar 有时会被杀软/索引服务锁住，
// 这时 electron-builder 清空 appOutDir 会报 "being used by another process"，换个目录即可。
const outDir = process.env.YJAI_OUT || 'dist-ia32';
const args = [
  cli,
  '--win', 'nsis:ia32',
  '-c.electronVersion=22.3.27',
  '-c.directories.output=' + outDir,
  '-c.win.artifactName=YJAI-Setup-${version}-ia32.${ext}'
];

const r = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  env: Object.assign({}, process.env, {
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  })
});
process.exit(r.status == null ? 1 : r.status);
