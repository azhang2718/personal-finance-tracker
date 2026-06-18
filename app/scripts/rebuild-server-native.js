// electron-builder `beforePack` hook.
//
// The local API server is bundled as a sidecar and run via ELECTRON_RUN_AS_NODE,
// so its native module (better-sqlite3) must match Electron's Node ABI — not the
// system Node used in dev. We stage a clean copy of ../server (including
// node_modules) into app/build-server and rebuild better-sqlite3 there for the
// target Electron version. extraResources ships this staging copy, leaving the
// source ../server untouched so `npm start` (system Node) keeps working.
const fs = require('fs');
const path = require('path');

// electron-builder Arch enum → string
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

module.exports = async function rebuildServerNative(context) {
  const srcServer = path.join(__dirname, '..', '..', 'server');
  const stageServer = path.join(__dirname, '..', 'build-server');
  const electronVersion = require('electron/package.json').version;
  const arch = ARCH[context.arch] ?? process.arch;

  console.log(`[beforePack] staging server → ${stageServer}`);
  fs.rmSync(stageServer, { recursive: true, force: true });
  fs.cpSync(srcServer, stageServer, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(srcServer, src);
      if (rel === '') return true;
      if (rel === 'data' || rel.startsWith('data' + path.sep)) return false;
      if (rel === '.env') return false;
      if (/\.db(-wal|-shm)?$/.test(rel)) return false;
      return true;
    },
  });

  console.log(`[beforePack] rebuilding better-sqlite3 for electron ${electronVersion} (${arch})`);
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({
    buildPath: stageServer,
    electronVersion,
    arch,
    onlyModules: ['better-sqlite3'],
  });
  console.log('[beforePack] native rebuild complete');
};
