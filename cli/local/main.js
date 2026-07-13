'use strict';
// MUST be set BEFORE any net / http / TLS modules load. The default libuv
// thread pool is 4 — that single pool is shared across every worker_thread,
// so even with 12 threads in flight, only 4 DNS / TLS / socket ops can run
// concurrently inside Node. Bumping it lets each worker_thread saturate its
// share of network I/O instead of queueing behind the libuv pool. 64 covers
// all reasonable thread counts × concurrent checks per thread.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64';

// CLI entry for the local-distributed checker.
//
//   node main.js [accounts.txt] [--resume <outDir>] [--key <licenseKey>]
//
// Activation: if no key is given/stored, prompt for email+password and exchange
// them with the control plane for a HWID-locked license key (cached locally).
// If the control plane is unreachable AND the email matches the embedded owner
// email, an HWID-stamped owner license is minted locally so the owner is never
// blocked when the VPS is down.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const childProcess = require('child_process');
const cp = require('./control-plane');
const updater = require('./updater');
const { run, VERSION } = require('./runner');
const log = require('./logger');
const brand = require('./brand');

const OWNER_EMAIL = (process.env.R6_OWNER_EMAIL || 'owner@example.com').toLowerCase();

// Folder that holds proxies.txt / accounts.txt / output — i.e. the folder the
// exe lives in. A Node SEA exe does NOT set process.pkg (that's a vercel/pkg
// flag); it reports itself via node:sea. Without this check baseDir fell back
// to process.cwd(), so proxies.txt next to the exe was invisible whenever the
// working directory wasn't the exe's folder → "No proxies — direct connection"
// → instant Ubisoft 429 storm. Mirrors the detection cli/checker.js uses.
function isSea() { try { return !!require('node:sea').isSea(); } catch { return false; } }
function appBaseDir() {
  return (process.pkg || isSea()) ? path.dirname(process.execPath) : process.cwd();
}

// Create empty accounts.txt / proxies.txt next to the exe on first run so the
// operator has obvious files to fill (and Import/Start can find them). Never
// overwrites existing files. Mirrors cli/checker.js's ensureFiles().
function ensureFiles(baseDir) {
  for (const f of ['accounts.txt', 'proxies.txt']) {
    const p = path.join(baseDir, f);
    try { if (!fs.existsSync(p)) fs.writeFileSync(p, ''); } catch {}
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') out.resume = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--pipeline') out.pipeline = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function keyStorePath() {
  const dir = path.join(os.homedir() || '.', '.r6checker');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, 'license.key');
}
function loadKey() { try { return fs.readFileSync(keyStorePath(), 'utf8').trim() || null; } catch { return null; } }
function saveKey(k) { try { fs.writeFileSync(keyStorePath(), k, { mode: 0o600 }); } catch {} }

function ask(q, { hidden = false } = {}) {
  // Mute readline's echo for hidden input. The earlier version defined a
  // keypress mirror but never attached it, so the Enter key sometimes fell into
  // a dead handler on Windows SEA — fall back to the simplest possible flow:
  // write the prompt, silence echo, read one line. Works in cmd.exe, Windows
  // Terminal, and over pipes alike.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(q);
      const orig = rl._writeToOutput;
      rl._writeToOutput = () => {};
      rl.question('', (ans) => { rl._writeToOutput = orig; process.stdout.write('\n'); rl.close(); resolve((ans || '').trim()); });
    } else {
      rl.question(q, (ans) => { rl.close(); resolve((ans || '').trim()); });
    }
  });
}

// Mint a deterministic HWID-stamped owner license used when the control plane
// is unreachable. Not a security boundary — the VPS would still reject this on
// any future API call — its sole purpose is to let the owner USE the desktop
// checker locally when their own VPS is down. Anyone else entering the owner
// email gets denied because the bypass only fires on a network-level failure
// AND requires a matching email.
function mintOwnerLicense() {
  const seed = (process.env.R6_OWNER_SEED || 'r6checker-local-owner-v1') + '|' + cp.hwid();
  return 'OWNER-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

function hasAccountLines(file, fsMod = fs) {
  try {
    if (!fsMod.existsSync(file)) return false;
    const text = fsMod.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).some(line => {
      const s = line.trim();
      return s && !s.startsWith('#') && s.includes(':');
    });
  } catch {
    return false;
  }
}

function accountFilePickerCommand(platform = process.platform) {
  if (platform !== 'win32') return null;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    '$dlg.Title = "Import accounts"',
    '$dlg.Filter = "Account files (*.txt)|*.txt|All files (*.*)|*.*"',
    '$dlg.Multiselect = $false',
    '$dlg.CheckFileExists = $true',
    '$dlg.InitialDirectory = [Environment]::GetFolderPath("Desktop")',
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }',
  ].join('; ');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    windowsHide: false,
  };
}

function pickAccountFile({ platform = process.platform, spawnSync = childProcess.spawnSync } = {}) {
  const cmd = accountFilePickerCommand(platform);
  if (!cmd) return null;
  const result = spawnSync(cmd.command, cmd.args, { encoding: 'utf8', windowsHide: !!cmd.windowsHide });
  const picked = String(result.stdout || '').trim();
  return picked || null;
}

function resolveInputFile({
  args,
  baseDir,
  exists = fs.existsSync,
  hasAccounts = hasAccountLines,
  pickAccountFile: picker = () => pickAccountFile(),
  info = log.info,
} = {}) {
  const explicit = args.input || args._[0];
  if (explicit) return explicit;

  const defaultInput = path.join(baseDir, 'accounts.txt');
  if (exists(defaultInput) && hasAccounts(defaultInput)) return defaultInput;

  info('Import accounts');
  info('Choose your accounts .txt file (email:password, one per line).');
  const selected = picker();
  if (selected) {
    info(`Imported accounts from ${selected}`);
    return selected;
  }
  return defaultInput;
}

async function ensureKey(argKey) {
  let key = argKey || process.env.R6_LICENSE_KEY || loadKey();
  if (key) return key;

  // Offline-only mode (the default): never touch the VPS for activation. Mint a
  // local HWID-bound license straight away — the desktop runs entirely on this
  // machine, so there's nothing to verify against an external server. The
  // license is non-transferable (it's tied to this machine's HWID).
  const { config } = require('./config');
  if (config.controlPlane.offline) {
    const k = mintOwnerLicense();
    saveKey(k);
    log.info('Activated locally (HWID-bound). License key cached for this device.');
    return k;
  }

  log.info('No license key found — opening website activation.');
  log.info('Sign in at https://r6checker.xyz if your browser asks, then return here.');
  const web = await cp.activateWithWebsite();
  if (web.ok) {
    saveKey(web.key);
    log.info(`Activated${web.account && web.account.email ? ` for ${web.account.email}` : ''}. License key cached for this device.`);
    return web.key;
  }

  log.warn(`Website activation unavailable: ${web.reason}`);
  log.info('Fallback: activate with your website email and password.');
  const email = (await ask('  Email: ')).toLowerCase();
  if (!email) { log.error('Activation cancelled.'); return null; }
  const password = await ask('  Password: ', { hidden: true });

  const r = await cp.login(email, password);
  if (r.ok) {
    saveKey(r.key);
    log.info('Activated. License key cached for this device.');
    return r.key;
  }

  // Owner offline-bypass: only when the control plane is unreachable (network
  // failure) AND the email matches the embedded owner email. Wrong-password /
  // 403 / etc. fall through to the normal error path.
  const offlineFailure = r.offline || /ECONN|ETIMED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|timed out|socket hang up/i.test(String(r.reason || ''));
  if (email === OWNER_EMAIL && offlineFailure) {
    const k = mintOwnerLicense();
    saveKey(k);
    log.warn('Control plane unreachable — minted local owner license. Use will be unrestricted on this machine.');
    return k;
  }

  log.error('Activation failed: ' + r.reason);
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`${brand.title} (local-distributed) v${VERSION}
Usage: ${brand.exe || 'r6checker'} [accounts.txt] [options]
  --resume <dir>   resume an interrupted run from its output folder
  --key <key>      license key (else cached/activated)
  --input <file>   accounts file (default ./accounts.txt)
Env: R6_MAX_WORKERS, R6_QUEUE_CAPACITY, R6_ADAPTIVE, R6_LOG_LEVEL, R6_OUTPUT_DIR …`);
    return;
  }

  const { config } = require('./config');
  const offline = config.controlPlane.offline;

  console.log(`\n  ${brand.title} — local-distributed ${brand.lite ? 'login validator' : 'bulk checker'} v${VERSION}`);
  console.log(`  Compute: local worker_threads · Mode: ${offline ? 'OFFLINE (no VPS)' : 'ONLINE (VPS license + updates)'}\n`);

  // Skip the VPS-driven self-updater in offline mode — the user explicitly asked
  // for a "purely desktop" build that doesn't reach back to the website.
  if (!offline) {
    const update = await updater.applyUpdateIfAvailable({ currentVersion: VERSION, argv: process.argv.slice(2), log, brand });
    if (update.restarting) {
      log.info(`Updated to ${update.version}. Restarting R6Checker...`);
      return;
    }
  }

  const key = await ensureKey(args.key);
  if (!key) { process.exitCode = 1; return; }

  const baseDir = appBaseDir();
  ensureFiles(baseDir);

  // One-shot mode: an explicit accounts file (arg/--input) OR --resume runs once
  // and exits — handy for scripting/automation. Otherwise launch the classic
  // ASCII menu (Start check / Import accounts / Import proxies / Sort results).
  const oneShot = !!(args.input || args._[0] || args.resume);
  if (oneShot) {
    const input = resolveInputFile({ args, baseDir });

    // Multi-process orchestrator: set R6_PROCESSES=N (or it auto-picks). Each
    // child gets its own libuv pool → throughput scales ~linearly up to the
    // proxy/IP budget. R6_WORKER_CHILD=1 in the env means THIS process is
    // already a child — fall through to the single-process runner so we don't
    // fork forever.
    const isChild = process.env.R6_WORKER_CHILD === '1';
    if (isChild) {
      const usePipe = process.env.R6_PIPELINE === '1' || args.pipeline;
      const { runPipelineSingle } = require('./pipeline');
      const res = usePipe
        ? await runPipelineSingle({ baseDir, input, licenseKey: key, quiet: true })
        : await run({ baseDir, input, licenseKey: key, resumeDir: args.resume });
      // Incomplete / stalled / stopped is normal for children (parent may kill them).
      // Only fail hard when there was no usable output and an explicit crash.
      process.exitCode = (res && res.crashed && !(res.processed > 0)) ? 1 : 0;
      return;
    }

    const { pickProcessCount, wantTwoPass, wantPipeline } = require('./speed');
    const { runTwoPass } = require('./twopass');
    const { runPipeline } = require('./pipeline');
    const lineCount = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(l => l.trim() && l.includes(':')).length;

    if ((wantPipeline(lineCount) || args.pipeline) && !args.resume) {
      const res = await runPipeline({ baseDir, input, licenseKey: key, totalLines: lineCount });
      process.exitCode = res.complete ? 0 : 1;
      if (process.stdout.isTTY && process.platform === 'win32') await ask('\n  Press Enter to exit…');
      return;
    }

    if (wantTwoPass(lineCount) && !args.resume) {
      const res = await runTwoPass({ baseDir, input, licenseKey: key, totalLines: lineCount });
      process.exitCode = res.complete ? 0 : 1;
      if (process.stdout.isTTY && process.platform === 'win32') await ask('\n  Press Enter to exit…');
      return;
    }

    const N = pickProcessCount(lineCount);

    if (N > 1 && !args.resume) {
      const { runMultiProcess } = require('./multiproc');
      const res = await runMultiProcess({ baseDir, input, licenseKey: key, processes: N });
      process.exitCode = res.complete ? 0 : 1;
      if (process.stdout.isTTY && process.platform === 'win32') await ask('\n  Press Enter to exit…');
      return;
    }

    const res = await run({ baseDir, input, licenseKey: key, resumeDir: args.resume });
    process.exitCode = (res.complete ?? res.ok) ? 0 : 1;
    if (process.stdout.isTTY && process.platform === 'win32') await ask('\n  Press Enter to exit…');
    return;
  }

  // Interactive menu — resolve the account (for the OWNER/unlimited line) from
  // the license. Offline mode skips the VPS call entirely; the local owner
  // license is always unlimited on this machine.
  let account = null;
  if (!offline) {
    try { const lic = await cp.verifyLicense(key); if (lic.ok) account = lic.account; } catch {}
  } else if (String(key).startsWith('OWNER-')) {
    account = { email: OWNER_EMAIL, plan: 'unlimited' };
  }
  const { runMenu } = require('./menu');
  await runMenu({ licenseKey: key, account, baseDir });
}

async function pauseBeforeExit() {
  try {
    if (process.stdout.isTTY && process.platform === 'win32') {
      await ask('\n  Press Enter to exit…');
    }
  } catch { /* ignore */ }
}

if (require.main === module) {
  process.on('uncaughtException', async (e) => {
    console.error('Fatal (uncaught):', e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    await pauseBeforeExit();
    process.exit(1);
  });
  process.on('unhandledRejection', async (e) => {
    console.error('Fatal (unhandled):', e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    await pauseBeforeExit();
    process.exit(1);
  });
  main().catch(async (e) => {
    console.error('Fatal:', e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    await pauseBeforeExit();
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  hasAccountLines,
  accountFilePickerCommand,
  pickAccountFile,
  resolveInputFile,
  main,
};
