// Electron main process.
// Spawns the local API server as a child process on launch, kills it on quit.
// Creates the dashboard window on startup and on demand.
const { app, BrowserWindow, ipcMain, shell, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// App icon (dark variant). Packaged builds use build/icon.icns via
// electron-builder; in dev we set the macOS dock icon explicitly since the
// BrowserWindow `icon` option is ignored on macOS.
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

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
// Nightly snapshot: while the app is running, refresh balances once a day so a
// data point is recorded each night (the server upserts one snapshot per day).
// ---------------------------------------------------------------------------

const SERVER_URL = 'http://127.0.0.1:8123';
const REFRESH_HOUR = 3; // 3 AM local
let nightlyTimer = null;

async function runRefresh() {
  try {
    const res = await fetch(`${SERVER_URL}/api/refresh`, { method: 'POST' });
    console.log(`[nightly] refresh triggered (status ${res.status})`);
  } catch (err) {
    console.warn('[nightly] refresh failed:', err.message);
  }
}

function msUntilNextRefreshHour() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(REFRESH_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleNightlyRefresh() {
  if (nightlyTimer) clearTimeout(nightlyTimer);
  nightlyTimer = setTimeout(function fire() {
    runRefresh();
    nightlyTimer = setTimeout(fire, 24 * 60 * 60 * 1000); // every 24h thereafter
  }, msUntilNextRefreshHour());
}

// ---------------------------------------------------------------------------
// Server environment file (Plaid credentials etc.)
//   Dev:      <repo>/server/.env      (loaded by the server via dotenv)
//   Packaged: <userData>/server.env   (injected into the child's env)
// ---------------------------------------------------------------------------

function serverEnvPath() {
  return app.isPackaged
    ? userDataPath('server.env')
    : path.join(__dirname, '..', 'server', '.env');
}

function serializeEnv(obj) {
  return (
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  );
}

// Non-secret status for the settings UI — never returns the actual secret.
function getServerEnvStatus() {
  const env = parseEnvFile(serverEnvPath());
  return {
    plaidConfigured: Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.ENCRYPTION_KEY),
    plaidEnv: env.PLAID_ENV || 'sandbox',
    clientIdHint: env.PLAID_CLIENT_ID ? `••••${env.PLAID_CLIENT_ID.slice(-4)}` : '',
  };
}

async function restartServer() {
  await new Promise((resolve) => {
    if (!serverProcess) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    serverProcess.once('exit', finish);
    serverProcess.kill();
    setTimeout(finish, 2500); // safety net if 'exit' never fires
  });
  serverProcess = null;
  startServer();
}

// Merge keys into the env file and restart the server so they take effect.
// Auto-generates an ENCRYPTION_KEY the first time Plaid credentials are set.
async function setServerEnv(partial) {
  const file = serverEnvPath();
  const next = { ...parseEnvFile(file) };
  for (const [k, v] of Object.entries(partial || {})) {
    if (v === undefined || v === null) continue;
    next[k] = String(v).trim();
  }
  if ((next.PLAID_CLIENT_ID || next.PLAID_SECRET) && !next.ENCRYPTION_KEY) {
    next.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeEnv(next), 'utf8');
  await restartServer();
  return getServerEnvStatus();
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

function createOrFocusDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  dashboardWindow = new BrowserWindow({
    width: Math.max(1200, Math.min(1600, width - 120)),
    height: Math.max(900, Math.min(1000, height - 120)),
    autoHideMenuBar: true,
    title: 'Net Worth Tracker',
    icon: APP_ICON,
    backgroundColor: '#EEF3F9',
    webPreferences: COMMON_WEB_PREFERENCES,
  });
  dashboardWindow.loadFile(path.join(__dirname, 'windows', 'dashboard.html'));
  dashboardWindow.maximize();
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

ipcMain.handle('get-cache', (_e, key) => getCache(String(key)));
ipcMain.handle('set-cache', (_e, key, value) => setCache(String(key), value));
ipcMain.handle('get-server-env-status', () => getServerEnvStatus());
ipcMain.handle('set-server-env', (_e, partial) => setServerEnv(partial));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON)) {
    app.dock.setIcon(nativeImage.createFromPath(APP_ICON));
  }
  startServer();
  createOrFocusDashboard();
  scheduleNightlyRefresh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOrFocusDashboard();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (nightlyTimer) clearTimeout(nightlyTimer);
  stopServer();
});
process.on('exit', stopServer);
