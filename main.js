'use strict';
// Planout main process. Local-only: no network access, files only via user-chosen dialogs.
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TITLE = 'Planout';
const granted = new Map(); // opaque id -> absolute path the user picked in a dialog
let win = null;

function grant(p) {
  const id = crypto.randomBytes(8).toString('hex');
  granted.set(id, p);
  return id;
}
function pathOf(id) {
  const p = granted.get(String(id));
  if (!p) throw new Error('Path was not granted by the user');
  return p;
}
module.exports = { grant, pathOf };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: TITLE, backgroundColor: '#262626', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

const filters = (list) => (list || []).map((f) => ({ name: f[0], extensions: f[1] }));

ipcMain.handle('file:open', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
    filters: filters(opts.filters),
  });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths) {
    const st = fs.statSync(p);
    const item = { id: grant(p), name: path.basename(p), size: st.size };
    if (opts.read !== false && st.size <= (opts.maxBytes || 512 * 1024 * 1024)) item.data = fs.readFileSync(p);
    out.push(item);
  }
  return out;
});

ipcMain.handle('file:save', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: opts.name, filters: filters(opts.filters),
  });
  if (r.canceled || !r.filePath) return null;
  if (opts.data) fs.writeFileSync(r.filePath, Buffer.from(opts.data));
  return { id: grant(r.filePath), name: path.basename(r.filePath) };
});

ipcMain.handle('file:write', async (_e, id, data) => {
  fs.writeFileSync(pathOf(id), Buffer.from(data));
  return true;
});

ipcMain.handle('file:read', async (_e, id) => fs.readFileSync(pathOf(id)));

ipcMain.handle('app:info', () => ({ name: TITLE, version: app.getVersion() }));



app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(false));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
