const { app, BrowserWindow, ipcMain, screen, shell, globalShortcut } = require('electron');
const path = require('path');
const { startServer } = require('./server');

let mainWindow = null;
let isTucked = false;
let isAlwaysOnTop = false;
let savedBounds = { width: 1050, height: 670, x: 140, y: 100 };
let serverPort = 3456;

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

  mainWindow.on('move', () => {
    if (!isTucked && mainWindow && !mainWindow.isMinimized()) {
      savedBounds = mainWindow.getBounds();
    }
  });

  mainWindow.on('resize', () => {
    if (!isTucked && mainWindow && !mainWindow.isMinimized()) {
      savedBounds = mainWindow.getBounds();
    }
  });
}

function tuckWindow() {
  if (!mainWindow || isTucked) return true;
  savedBounds = mainWindow.getBounds();
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
  mainWindow.setBounds(savedBounds, true);
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

app.whenReady().then(async () => {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

