'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const childProcess = require('child_process');
const { config } = require('./config');
const cp = require('./control-plane');

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function normalizeUpdateInfo({ currentVersion, update, baseUrl = config.controlPlane.baseUrl, fallbackExe = 'R6Checker.exe' }) {
  const latest = update && (update.latest || update.version);
  if (!update || !latest || compareVersions(latest, currentVersion) <= 0) {
    return { available: false, version: latest || currentVersion, url: null };
  }
  const rawUrl = update.url || ('/downloads/' + fallbackExe);
  const url = new URL(rawUrl, baseUrl).toString();
  return { available: true, version: latest, url };
}

function downloadFile(urlStr, dest) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'http:' ? http : https;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const req = lib.get(url, { headers: { Accept: 'application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        downloadFile(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        reject(new Error(`download HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            resolve(dest);
          } catch (e) {
            reject(e);
          }
        });
      });
    });
    req.on('error', (e) => {
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      reject(e);
    });
    out.on('error', reject);
  });
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function buildWindowsInstallPlan({ currentExe, downloadedExe, argv = [], pid = process.pid }) {
  const quotedArgs = argv.map(psQuote).join(', ');
  const safePid = Number(pid) || 0;
  const script = [
    `$target = ${psQuote(currentExe)}`,
    `$source = ${psQuote(downloadedExe)}`,
    `Wait-Process -Id ${safePid} -Timeout 60 -ErrorAction SilentlyContinue`,
    `Copy-Item -LiteralPath $target -Destination ($target + '.old') -Force -ErrorAction SilentlyContinue`,
    `Move-Item -LiteralPath $source -Destination $target -Force`,
    `Start-Process -FilePath $target -ArgumentList @(${quotedArgs})`,
  ].join('; ');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    options: { detached: true, stdio: 'ignore', windowsHide: true },
  };
}

function isPackagedWindowsExe() {
  return process.platform === 'win32' && /\.exe$/i.test(process.execPath);
}

async function applyUpdateIfAvailable({ currentVersion, argv = process.argv.slice(2), log = console, brand = null } = {}) {
  const brandId = (brand && brand.id) || null;
  const brandTitle = (brand && brand.title) || 'R6Checker';
  const fallbackExe = (brand && brand.exe ? brand.exe : 'R6Checker') + '.exe';
  let update;
  try {
    update = await cp.checkUpdate(currentVersion, brandId);
  } catch (e) {
    if (log.debug) log.debug('update check failed: ' + e.message);
    return { updated: false, reason: e.message };
  }
  const normalized = normalizeUpdateInfo({ currentVersion, update, fallbackExe });
  if (!normalized.available) return { updated: false, reason: 'current' };
  if (!isPackagedWindowsExe()) {
    if (log.warn) log.warn(`Update available: ${normalized.version} (${normalized.url})`);
    return { updated: false, reason: 'not-packaged', update: normalized };
  }

  if (log.warn) log.warn(`Updating ${brandTitle} to ${normalized.version}...`);
  const dest = path.join(os.tmpdir(), `${(brand && brand.exe) || 'R6Checker'}-${normalized.version}.exe`);
  await downloadFile(normalized.url, dest);
  const plan = buildWindowsInstallPlan({
    currentExe: process.execPath,
    downloadedExe: dest,
    argv,
    pid: process.pid,
  });
  childProcess.spawn(plan.command, plan.args, plan.options).unref();
  return { updated: true, restarting: true, version: normalized.version };
}

module.exports = {
  compareVersions,
  normalizeUpdateInfo,
  downloadFile,
  buildWindowsInstallPlan,
  applyUpdateIfAvailable,
};
