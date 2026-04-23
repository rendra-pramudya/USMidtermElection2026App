'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { PushService, loadConfig } = require('../shared/pushService');

let mainWindow = null;
let pushService = null;
let recentEvents = []; // ring buffer for UI

function pushEvent(evt) {
  recentEvents.unshift({ ...evt, t: Date.now() });
  if (recentEvents.length > 200) recentEvents.pop();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('event', evt);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function startService() {
  const cfg = loadConfig();
  pushService = new PushService(cfg);
  pushService.on('status', (s) => pushEvent({ kind: 'status', ...s }));
  pushService.on('push', (p) => pushEvent({ kind: 'push', ...p }));
  pushService.on('command', (c) => pushEvent({ kind: 'command', ...c }));
  pushService.start();
}

app.whenReady().then(() => {
  startService();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pushService) pushService.stop();
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers used by the renderer.
ipcMain.handle('get-stats', () => pushService ? pushService.getStats() : null);
ipcMain.handle('get-events', () => recentEvents.slice(0, 100));
ipcMain.handle('push-now', async () => pushService ? pushService.pushNow('manual-ui') : null);
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('apply-override', (_evt, override) => {
  if (pushService) pushService.applyOverride(override);
  return true;
});
ipcMain.handle('clear-overrides', async () => {
  if (pushService) {
    pushService.clearOverrides();
    // forceFields=true so per-field keys are pushed even when pushMode='files',
    // ensuring any previously overridden Viz keys are reset to file values.
    return pushService.pushNow('clear-overrides', true);
  }
  return true;
});

// Single field edit: store override + push immediately
ipcMain.handle('field-edit', async (_evt, override) => {
  if (!pushService) return { ok: false };
  pushService.applyOverride(override);
  const result = await pushService.pushNow('field-edit');
  return { ok: true, result };
});

// Batch field edits: store all overrides + push once
ipcMain.handle('field-edits', async (_evt, overrides) => {
  if (!pushService) return { ok: false };
  for (const o of overrides) pushService.applyOverride(o);
  const result = await pushService.pushNow('field-edits-batch');
  return { ok: true, result };
});

// Election dashboard data — always returns file data + any active overrides
ipcMain.handle('get-election-data', () => {
  try {
    return pushService ? pushService.getDataWithOverrides() : loadAll(loadConfig().dataSource);
  } catch (e) {
    console.error('get-election-data error:', e);
    return null;
  }
});

// US map SVG
ipcMain.handle('get-svg', () => {
  const svgPath = path.join(__dirname, '..', '..', 'us.svg');
  return fs.existsSync(svgPath) ? fs.readFileSync(svgPath, 'utf8') : null;
});
