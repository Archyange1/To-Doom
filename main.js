const { app, BrowserWindow, ipcMain, screen, shell, globalShortcut, Notification, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer, closeServer } = require('./server');

const WINDOWS_AUMID = 'com.todoom.app';
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(WINDOWS_AUMID);
  } catch (_) {}
}

let mainWindow = null;
let isTucked = false;
let isAlwaysOnTop = false;
let savedBounds = { width: 1050, height: 670, x: 140, y: 100 };
let serverPort = 3456;
const recentNotificationKeys = new Map();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (isTucked) untuckWindow();
      mainWindow.focus();
    }
  });
}

function createWindow(port) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
  const initW = Math.min(1050, Math.round(screenW * 0.85));
  const initH = Math.min(670, Math.round(screenH * 0.82));
  const initX = Math.round((screenW - initW) / 2);
  const initY = Math.round((screenH - initH) / 2);

  savedBounds = { x: initX, y: initY, width: initW, height: initH };

  mainWindow = new BrowserWindow({
    x: initX,
    y: initY,
    width: initW,
    height: initH,
    minWidth: 380,
    minHeight: 420,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    show: false,
    icon: path.join(__dirname, 'ToDoom.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  function captureSavedBounds() {
    if (!isTucked && mainWindow && !mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      if (b && b.width >= 380 && b.height >= 420) {
        savedBounds = b;
      }
    }
  }

  mainWindow.on('move', captureSavedBounds);
  mainWindow.on('resize', captureSavedBounds);
}

function registerWindowsToastAppId() {
  if (process.platform !== 'win32') return;
  try {
    const iconCandidate = fs.existsSync(path.join(__dirname, 'ToDoom.ico'))
      ? path.join(__dirname, 'ToDoom.ico')
      : path.join(__dirname, 'public', 'icon-192.png');
    const regKey = `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_AUMID}`;
    const opts = { windowsHide: true };
    execFile('reg.exe', ['add', regKey, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'To Doom', '/f'], opts, () => {});
    execFile('reg.exe', ['add', regKey, '/v', 'ShowInSettings', '/t', 'REG_DWORD', '/d', '1', '/f'], opts, () => {});
    if (fs.existsSync(iconCandidate)) {
      execFile('reg.exe', ['add', regKey, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconCandidate, '/f'], opts, () => {});
    }
  } catch (_) {}
}

function getNotificationIcon() {
  const pngPath = path.join(__dirname, 'public', 'icon-192.png');
  const icoPath = path.join(__dirname, 'ToDoom.ico');
  const target = fs.existsSync(pngPath) ? pngPath : (fs.existsSync(icoPath) ? icoPath : null);
  if (!target) return undefined;
  try {
    const img = nativeImage.createFromPath(target);
    return img.isEmpty() ? undefined : img;
  } catch (_) {
    return undefined;
  }
}

function showAgentNotification(payload) {
  if (!payload || !payload.actionKind || !payload.title) return;
  const now = Date.now();
  for (const [k, ts] of recentNotificationKeys.entries()) {
    if (now - ts > 15000) recentNotificationKeys.delete(k);
  }
  const eventKey = payload.eventKey || `${payload.actionKind}:${payload.taskId}:${Math.floor(now / 2000)}`;
  if (recentNotificationKeys.has(eventKey)) return;
  recentNotificationKeys.set(eventKey, now);

  if (mainWindow && !mainWindow.isDestroyed() && isTucked) {
    try { mainWindow.webContents.send('agent-notify-pulse'); } catch (_) {}
  }

  try {
    if (!Notification.isSupported()) return;
    const projectLabel = payload.projectName || 'To Doom';
    const assigneeLabel = payload.assignee ? ` (${payload.assignee})` : '';
    const epicSuffix = payload.epic ? ` · ${payload.epic}` : '';

    let notifTitle = `To Doom · ${projectLabel}`;
    if (payload.actionKind === 'created') {
      notifTitle = `🤖 ШІ додав задачу · ${projectLabel}`;
    } else if (payload.actionKind === 'created_done') {
      notifTitle = `✅ ШІ додав і завершив · ${projectLabel}`;
    } else if (payload.actionKind === 'completed') {
      notifTitle = `✅ Агент завершив задачу · ${projectLabel}`;
    }

    const notifBody = `#${payload.taskId} ${payload.title}${epicSuffix}${assigneeLabel}`;
    const notif = new Notification({
      title: notifTitle,
      body: notifBody,
      icon: getNotificationIcon(),
      silent: false
    });

    notif.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (isTucked) untuckWindow();
      mainWindow.show();
      mainWindow.focus();
    });

    notif.show();
  } catch (_) {}
}

function tuckWindow() {
  if (!mainWindow || isTucked) return true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  const current = mainWindow.getBounds();
  if (current && current.width >= 380 && current.height >= 420) {
    savedBounds = current;
  }
  const display = screen.getDisplayMatching(savedBounds);
  const workArea = display.workArea;

  isTucked = true;
  const tabWidth = 24;
  const tabHeight = 136;
  const targetX = workArea.x + workArea.width - tabWidth;
  const targetY = Math.max(
    workArea.y + 40,
    Math.min(
      savedBounds.y + Math.round((savedBounds.height - tabHeight) / 2),
      workArea.y + workArea.height - tabHeight - 40
    )
  );

  mainWindow.setMinimumSize(tabWidth, tabHeight);
  mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.setBounds({ x: targetX, y: targetY, width: tabWidth, height: tabHeight }, true);
  mainWindow.webContents.send('tuck-changed', true);
  return true;
}

function untuckWindow() {
  if (!mainWindow || !isTucked) return false;
  isTucked = false;
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(380, 420);
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  const restoreBounds = (savedBounds && savedBounds.width >= 380 && savedBounds.height >= 420)
    ? savedBounds
    : { width: 1050, height: 670, x: 140, y: 100 };
  mainWindow.setBounds(restoreBounds, true);
  mainWindow.focus();
  mainWindow.webContents.send('tuck-changed', false);
  return false;
}

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-toggle-tuck', () => {
  if (isTucked) return untuckWindow();
  return tuckWindow();
});

ipcMain.handle('window-untuck', () => {
  return untuckWindow();
});

ipcMain.handle('window-toggle-aot', () => {
  if (!mainWindow) return false;
  isAlwaysOnTop = !isAlwaysOnTop;
  if (!isTucked) {
    mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  }
  mainWindow.webContents.send('aot-changed', isAlwaysOnTop);
  return isAlwaysOnTop;
});

ipcMain.handle('window-get-state', () => {
  return { isTucked, isAlwaysOnTop, serverPort };
});

ipcMain.on('open-external', (_event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

ipcMain.on('agent-task-notify', (_event, payload) => {
  showAgentNotification(payload);
});

process.on('todoom-agent-notify', (payload) => {
  showAgentNotification(payload);
});

app.whenReady().then(async () => {
  registerWindowsToastAppId();
  const { port } = await startServer(3456);
  serverPort = port;
  createWindow(port);

  // Global hotkey Alt+S to quickly tuck/untuck the board from anywhere in Windows
  try {
    globalShortcut.register('Alt+S', () => {
      if (!mainWindow) return;
      if (isTucked) {
        untuckWindow();
      } else {
        tuckWindow();
      }
    });
  } catch (_) {}
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

process.on('todoom-app-updated', () => {
  setTimeout(() => {
    try { if (typeof closeServer === 'function') closeServer(); } catch (_) {}
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);
  }, 800);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

