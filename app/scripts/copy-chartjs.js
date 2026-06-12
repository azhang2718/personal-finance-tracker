// Copies the Chart.js UMD build from node_modules into app/lib/ so the
// renderer can load it locally (no CDN, no remote code). Runs on postinstall.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(__dirname, '..', 'lib');
const dest = path.join(destDir, 'chart.umd.js');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[copy-chartjs] copied ${src} -> ${dest}`);
