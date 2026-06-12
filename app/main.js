// Electron main process.
// Spawns the local API server as a child process on launch, kills it on quit.
// Creates the mini window on startup and the dashboard window on demand.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = {
  apiBaseUrl: 'http://127.0.0.1:8123',
};

let miniWindow = null;
let dashboardWindow = null;
let serverProcess = null;

// ---------------------------------------------------------------------------
// Settings + cache persistence (JSON files in userData)
// ---------------------------------------------------------------------------

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function getSettings() {
  const stored = readJsonFile(userDataPath('settings.json'), {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

function setSettings(partial) {
  const merged = { ...getSettings(), ...(partial || {}) };
  writeJsonFile(userDataPath('settings.json'), merged);
  return merged;
}

function getCache(key) {
  const cache = readJsonFile(userDataPath('cache.json'), {});
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
}

function setCache(key, value) {
  const file = userDataPath('cache.json');
  const cache = readJsonFile(file, {});
  cache[key] = value;
  writeJsonFile(file, cache);
  return true;
}

// ---------------------------------------------------------------------------
// Server child process
// ---------------------------------------------------------------------------

// Parse a minimal dotenv-style file (KEY=value lines, # comments).
function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function startServer() {
  if (app.isPackaged) {
    // Packaged: bundled server lives in resources/server. Its config comes
    // from a dotenv-style file the user places in the app's user-data dir
    // (server.env), and the SQLite DB lives in user-data too.
    const serverDir = path.join(process.resourcesPath, 'server');
    const entry = path.join(serverDir, 'index.js');
    const envFile = userDataPath('server.env');
    const fileEnv = parseEnvFile(envFile);

    const env = {
      ...process.env,
      ...fileEnv,
      DB_PATH: fileEnv.DB_PATH || userDataPath('networth.db'),
      // Run the bundled Electron binary as plain Node — no second runtime needed.
      ELECTRON_RUN_AS_NODE: '1',
    };

    serverProcess = spawn(process.execPath, [entry], {
      cwd: serverDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // Dev: run the repo server with the system Node; it loads server/.env itself.
    const serverDir = path.join(__dirname, '..', 'server');
    serverProcess = spawn('node', [path.join(serverDir, 'index.js')], {
      cwd: serverDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`[main] server process exited with code ${code}`);
    serverProcess = null;
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const COMMON_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false, // preload uses no node APIs beyond ipcRenderer; kept false for compat
  preload: path.join(__dirname, 'preload.js'),
};

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.focus();
    return;
  }
  miniWindow = new BrowserWindow({
    width: 360,
    height: 480,
    useContentSize: true, // 360×480 of content — frame/menu don't eat into it
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Net Worth',
    backgroundColor: '#EEF3F9',
    webPreferences: COMMON_WEB_PREFERENCES,
  });
  miniWindow.loadFile(path.join(__dirname, 'windows', 'mini.html'));
  miniWindow.on('closed', () => {
    miniWindow = null;
  });
}

function createOrFocusDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    autoHideMenuBar: true,
    title: 'Net Worth Tracker',
    backgroundColor: '#EEF3F9',
    webPreferences: COMMON_WEB_PREFERENCES,
  });
  dashboardWindow.loadFile(path.join(__dirname, 'windows', 'dashboard.html'));
  // Hosted Plaid Link (and any other https link) opens in the system browser,
  // never an Electron child window.
  dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC bridge handlers (the only surface exposed to renderers via preload)
// ---------------------------------------------------------------------------

ipcMain.handle('open-dashboard', () => {
  createOrFocusDashboard();
  return true;
});
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('set-settings', (_e, partial) => setSettings(partial));
ipcMain.handle('get-cache', (_e, key) => getCache(String(key)));
ipcMain.handle('set-cache', (_e, key, value) => setCache(String(key), value));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  startServer();
  createMiniWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMiniWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopServer);
process.on('exit', stopServer);
