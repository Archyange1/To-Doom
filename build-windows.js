const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const INSTALL_DIR = 'D:\\To Doom';
const DESKTOP_DIR = 'C:\\Users\\foxxx\\Desktop';

// 1. Generate a crisp 256x256 PNG + ICO file (ToDoom.ico)
function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = createCrc32Table();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function pointInRoundedRect(x, y, rx, ry, rw, rh, rad) {
  if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false;
  const cx = Math.max(rx + rad, Math.min(x, rx + rw - rad));
  const cy = Math.max(ry + rad, Math.min(y, ry + rh - rad));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function generateIconBuffer() {
  const W = 256;
  const H = 256;
  const raw = Buffer.alloc(H * (1 + W * 4));

  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < W; x++) {
      const idx = rowStart + 1 + x * 4;
      const inOuter = pointInRoundedRect(x, y, 8, 8, 240, 240, 54);
      if (!inOuter) {
        raw[idx] = 0;
        raw[idx + 1] = 0;
        raw[idx + 2] = 0;
        raw[idx + 3] = 0;
        continue;
      }

      const inInnerBg = pointInRoundedRect(x, y, 14, 14, 228, 228, 48);
      const bar1 = pointInRoundedRect(x, y, 56, 104, 32, 96, 12);
      const bar2 = pointInRoundedRect(x, y, 112, 56, 32, 144, 12);
      const bar3 = pointInRoundedRect(x, y, 168, 132, 32, 68, 12);

      if (bar1 || bar2 || bar3) {
        // #22c55e
        raw[idx] = 0x22;
        raw[idx + 1] = 0xc5;
        raw[idx + 2] = 0x5e;
        raw[idx + 3] = 255;
      } else if (inInnerBg) {
        // #0d1912
        raw[idx] = 0x0d;
        raw[idx + 1] = 0x19;
        raw[idx + 2] = 0x12;
        raw[idx + 3] = 255;
      } else {
        // Border #1e462f
        raw[idx] = 0x1e;
        raw[idx + 1] = 0x46;
        raw[idx + 2] = 0x2f;
        raw[idx + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngBuf = Buffer.concat([
    pngSig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);

  // Wrap PNG in ICO header
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2); // type 1 = ICO
  icoHeader.writeUInt16LE(1, 4); // 1 image

  const dirEntry = Buffer.alloc(16);
  dirEntry[0] = 0; // 256px
  dirEntry[1] = 0; // 256px
  dirEntry[2] = 0;
  dirEntry[3] = 0;
  dirEntry.writeUInt16LE(1, 4); // color planes
  dirEntry.writeUInt16LE(32, 6); // bpp
  dirEntry.writeUInt32LE(pngBuf.length, 8);
  dirEntry.writeUInt32LE(22, 12); // offset = 6 + 16

  return Buffer.concat([icoHeader, dirEntry, pngBuf]);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('1. Генерація іконки ToDoom.ico...');
const icoBuf = generateIconBuffer();
const projectIcoPath = path.join(ROOT, 'ToDoom.ico');
fs.writeFileSync(projectIcoPath, icoBuf);

console.log('2. Встановлення готової програми у D:\\To Doom...');
if (fs.existsSync(INSTALL_DIR)) {
  try {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  } catch (_) {}
}
fs.mkdirSync(INSTALL_DIR, { recursive: true });

// Copy Electron runtime into D:\To Doom
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
copyDirRecursive(electronDist, INSTALL_DIR);

// Rename electron.exe -> To Doom.exe
const srcExe = path.join(INSTALL_DIR, 'electron.exe');
const targetExe = path.join(INSTALL_DIR, 'To Doom.exe');
if (fs.existsSync(srcExe)) {
  fs.renameSync(srcExe, targetExe);
}

// Remove default_app.asar so Electron loads resources/app
const defaultAsar = path.join(INSTALL_DIR, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) {
  fs.rmSync(defaultAsar, { force: true });
}

// Populate D:\To Doom\resources\app
const appResDir = path.join(INSTALL_DIR, 'resources', 'app');
fs.mkdirSync(appResDir, { recursive: true });

const filesToCopy = ['package.json', 'main.js', 'preload.js', 'server.js', 'mcp-server.js', 'ToDoom.ico'];
for (const f of filesToCopy) {
  if (fs.existsSync(path.join(ROOT, f))) {
    fs.copyFileSync(path.join(ROOT, f), path.join(appResDir, f));
  }
}
fs.copyFileSync(projectIcoPath, path.join(INSTALL_DIR, 'ToDoom.ico'));

copyDirRecursive(path.join(ROOT, 'public'), path.join(appResDir, 'public'));
if (fs.existsSync(path.join(ROOT, 'data'))) {
  copyDirRecursive(path.join(ROOT, 'data'), path.join(appResDir, 'data'));
}

// Copy all runtime node_modules (excluding electron itself)
const srcNodeModules = path.join(ROOT, 'node_modules');
const destNodeModules = path.join(appResDir, 'node_modules');
fs.mkdirSync(destNodeModules, { recursive: true });
for (const entry of fs.readdirSync(srcNodeModules, { withFileTypes: true })) {
  if (entry.name === 'electron' || entry.name === '@electron' || entry.name === '.bin') continue;
  const s = path.join(srcNodeModules, entry.name);
  const d = path.join(destNodeModules, entry.name);
  if (entry.isDirectory()) copyDirRecursive(s, d);
  else fs.copyFileSync(s, d);
}

console.log('3. Створення ярликів у папці проєкту та на Робочому столі...');
const lnkProject = path.join(ROOT, 'To Doom.lnk');
const lnkDesktop = path.join(DESKTOP_DIR, 'To Doom.lnk');
const icoInstalled = path.join(INSTALL_DIR, 'ToDoom.ico');

const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$s1 = $WshShell.CreateShortcut('${lnkProject.replace(/'/g, "''")}')
$s1.TargetPath = '${targetExe.replace(/'/g, "''")}'
$s1.WorkingDirectory = '${INSTALL_DIR.replace(/'/g, "''")}'
$s1.IconLocation = '${icoInstalled.replace(/'/g, "''")},0'
$s1.Description = 'To Doom — Дошка задач'
$s1.Save()

$s2 = $WshShell.CreateShortcut('${lnkDesktop.replace(/'/g, "''")}')
$s2.TargetPath = '${targetExe.replace(/'/g, "''")}'
$s2.WorkingDirectory = '${INSTALL_DIR.replace(/'/g, "''")}'
$s2.IconLocation = '${icoInstalled.replace(/'/g, "''")},0'
$s2.Description = 'To Doom — Дошка задач'
$s2.Save()
`;

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'inherit' });

console.log('ГОТОВО!');
console.log(' -> Встановлена програма: ' + targetExe);
console.log(' -> Ярлик у папці:        ' + lnkProject);
console.log(' -> Ярлик на Робочому столі: ' + lnkDesktop);

