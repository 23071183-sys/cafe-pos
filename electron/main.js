// Cafe POS — Electron desktop shell
// Boots the bundled Express server with a local SQLite DB (offline-first),
// then shows a launcher window with POS + Admin.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 4317; // fixed local port for the embedded server
let mainWindow = null;

// ── Config: writable data dir + first-run defaults ──────────────────────────
function setupEnv() {
  const userData = app.getPath('userData');
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });

  // Local SQLite lives in the writable userData dir (survives app updates).
  process.env.DB_PATH = path.join(userData, 'cafepos.db');
  process.env.PORT = String(PORT);

  // Optional config.json in userData lets the owner set creds + Turso sync.
  // { adminEmail, adminPassword, posPin, tursoUrl, tursoToken, publicUrl }
  let cfg = {};
  const cfgPath = path.join(userData, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  } else {
    // write a default config the owner can edit
    cfg = { adminEmail: 'admin@cafe.local', adminPassword: 'admin', posPin: '1234' };
    try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch {}
  }

  process.env.ADMIN_EMAIL    = cfg.adminEmail    || 'admin@cafe.local';
  process.env.ADMIN_PASSWORD = cfg.adminPassword || 'admin';
  process.env.POS_PIN        = cfg.posPin        || '1234';
  if (cfg.tursoUrl)   process.env.TURSO_DATABASE_URL = cfg.tursoUrl;
  if (cfg.tursoToken) process.env.TURSO_AUTH_TOKEN   = cfg.tursoToken;
  process.env.PUBLIC_URL = cfg.publicUrl || `http://localhost:${PORT}`;

  return { userData, cfgPath };
}

// ── Start the embedded server (require the existing Express app) ─────────────
function startServer() {
  // server.js calls server.listen(process.env.PORT) on require
  require(path.join(__dirname, '..', 'server.js'));
}

// Poll until the server answers, then resolve
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/menu', timeout: 2000 }, res => {
        res.destroy(); resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server start timeout'));
        setTimeout(tryOnce, 400);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tryOnce();
  });
}

// ── Navigation helpers ──────────────────────────────────────────────────────
const url = (p) => `http://localhost:${PORT}${p}`;
function go(p) { if (mainWindow) mainWindow.loadURL(url(p)); }
function goLauncher() { if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'launcher.html')); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Navigate',
      submenu: [
        { label: 'Home (Launcher)', accelerator: 'CmdOrCtrl+H', click: goLauncher },
        { label: 'POS Terminal',    accelerator: 'CmdOrCtrl+1', click: () => go('/counter') },
        { label: 'Admin Dashboard', accelerator: 'CmdOrCtrl+2', click: () => go('/admin') },
        { label: 'Customer Menu',   accelerator: 'CmdOrCtrl+3', click: () => go('/menu?table=1') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => mainWindow && mainWindow.webContents.navigationHistory.canGoBack() && mainWindow.webContents.navigationHistory.goBack() },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
        { label: 'About', click: () => dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'Cafe POS',
            message: 'Cafe POS — Desktop',
            detail: `Offline-capable POS & admin.\nData: ${process.env.DB_PATH}\nTurso sync: ${process.env.TURSO_DATABASE_URL ? 'ON' : 'OFF'}`,
          }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'Cafe POS',
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // expose port to the launcher page
  global._POS_PORT = PORT;
  goLauncher();
  // open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(u); return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  setupEnv();
  startServer();
  try { await waitForServer(); }
  catch (e) {
    dialog.showErrorBox('Cafe POS', 'The local server failed to start.\n\n' + e.message);
  }
  buildMenu();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
