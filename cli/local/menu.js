'use strict';
// Interactive ASCII front-end for the local-distributed checker — the classic
// R6Checker desktop look (art splash, menu, live dashboard, sorter), but every
// account is checked by LOCAL worker_threads (runner.run) instead of being
// submitted to the VPS. The control plane is touched only for license/updates.
//
// Mirrors cli/checker.js's UI 1:1 (colors, splash, paint, sorter, VWI split) so
// the experience is identical to "how it used to be".

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { run, loadProxies } = require('./runner');
const { runMultiProcess } = require('./multiproc');
const { runPipeline } = require('./pipeline');
const { pickProcessCount, wantTwoPass, wantPipeline } = require('./speed');
const { formatOutcome } = require('./runStatus');
const { createStallWatch } = require('./stallWatch');
const { commitPartialFiles } = require('./outputFiles');
const cp = require('./control-plane');
const fmt = require('../../lib/checker/resultFormat');
const brand = require('./brand');
const LITE = !!brand.lite;

// ── palette (identical to checker.js) ──────────────────────────────────────
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const sky = s => c('38;5;75', s), green = s => c('38;5;42', s),
      red = s => c('38;5;203', s), mag = s => c('38;5;213', s), dim = s => c('38;5;240', s),
      bold = s => c('1', s), yellow = s => c('38;5;221', s), white = s => c('38;5;255', s),
      orange = s => c('38;5;208', s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function setTitle(t) { try { process.title = t; } catch {} try { process.stdout.write('\x1b]0;' + t + '\x07'); } catch {} }
function clear() { try { process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); } catch {} }

// ── ASCII art (shipped as SEA assets 'art' / 'art-sm', or read from cli/*.txt
//    in dev). Same pixel art the old exe used. ──────────────────────────────
function loadArt(asset, file, baseDir) {
  let raw = '';
  try {
    const sea = require('node:sea');
    if (sea && sea.isSea && sea.isSea()) raw = sea.getAsset(asset, 'utf8');
  } catch { /* not SEA */ }
  if (!raw) {
    for (const p of [path.join(__dirname, '..', file), path.join(baseDir || '.', file)]) {
      try { raw = fs.readFileSync(p, 'utf8'); break; } catch {}
    }
  }
  if (!raw) return [];
  return raw.replace(/\n+$/, '').split('\n');
}
let ART_LINES = [], ART_SM = [];

const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
function splash(account) {
  clear();
  console.log();
  const cols = process.stdout.columns || 80;
  const ctr = (s) => ' '.repeat(Math.max(0, Math.floor((cols - vis(s)) / 2))) + s;
  for (const l of ART_LINES) console.log(ctr(l));
  console.log();
  console.log(ctr(white(bold(brand.name)) + dim('  ·  ' + brand.subtitle)));
  console.log(ctr(dim(`local worker_threads  ·  https://r6checker.xyz`)));
  console.log(ctr(dim('─'.repeat(46))));
  console.log();
}

function accessLine(b) {
  if (!b) return '   ' + green('● ready');
  if (b.owner || b.unlimited) return '   ' + green('● OWNER') + dim('  ·  unlimited') + dim('   ·   ') + white(b.email || '');
  const exp = b.expiresAt ? new Date(b.expiresAt).toLocaleDateString() : 'active';
  return '   ' + green('● active') + dim('  ·  ') + green(exp) + dim('   ·   ') + white(b.email || '');
}

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    restoreStdin();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (/[\r\n]/.test(s)) rl.output.write(s); else if (rl.line.length === 0) rl.output.write(s); else rl.output.write('•'); };
    rl.question(q, (a) => { rl.close(); restoreStdin(); resolve((a || '').trim()); });
  });
}

// ── live-run keypress (S/q/Esc = stop) ──────────────────────────────────────
// ask()'s readline closes leave stdin PAUSED — resume + raw mode before listening.
let _stdinListenDepth = 0;

function restoreStdin() {
  if (_stdinListenDepth > 0) return; // don't clobber active stop-key listener
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  } catch { /* ignore */ }
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
  } catch { /* ignore */ }
}

function primeStdinForStop() {
  if (!process.stdin.isTTY) return false;
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setEncoding('utf8');
    if (process.stdin.isPaused()) process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return true;
  } catch {
    return false;
  }
}

function keyControl(onStop) {
  if (!process.stdin.isTTY) return () => {};
  if (!primeStdinForStop()) return () => {};

  _stdinListenDepth++;
  let active = true;
  let stopping = false;

  const stopKeys = new Set(['s', 'q']);
  const h = (str, k) => {
    if (!active) return;
    if (k && k.name === 'c' && k.ctrl) {
      active = false;
      _stdinListenDepth = Math.max(0, _stdinListenDepth - 1);
      restoreStdin();
      process.exit(0);
    }
    const s = (str || '').toLowerCase();
    const name = k && k.name ? String(k.name).toLowerCase() : '';
    if (stopKeys.has(s) || stopKeys.has(name) || (k && k.name === 'escape')) {
      if (stopping) return;
      stopping = true;
      active = false;
      try { process.stdin.removeListener('keypress', h); } catch { /* ignore */ }
      _stdinListenDepth = Math.max(0, _stdinListenDepth - 1);
      restoreStdin();
      try { onStop(); } catch { /* ignore */ }
    }
  };
  process.stdin.on('keypress', h);
  return () => {
    if (!active && _stdinListenDepth === 0) return;
    active = false;
    try { process.stdin.removeListener('keypress', h); } catch { /* ignore */ }
    _stdinListenDepth = Math.max(0, _stdinListenDepth - 1);
    restoreStdin();
  };
}

function label(s) {
  switch (s) {
    case 'vwi':     return mag(' VWI ');
    case 'twofa':   return yellow(' 2FA ');
    case 'banned':  return red(' BAN ');
    case 'valid':   return green('VALID');
    case 'invalid': return dim(' INV ');
    case 'retry':   return orange(' BLK ');
    case 'err':     return red(' ERR ');
    default:        return dim(' ··· ');
  }
}
function fmtEta(s) {
  if (!s || s < 0 || !isFinite(s)) return '—';
  if (s >= 3600) return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  if (s >= 60)   return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  return Math.round(s) + 's';
}
const g = (co, k) => co[k] || 0;
function titleStr(co, done, total, cps, eta) {
  const vwi = LITE ? '' : `VWI:${g(co,'vwi')} `;
  return `${brand.title}  |  ${done.toLocaleString()}/${total.toLocaleString()}  |  ETA ${fmtEta(eta)}  |  ${cps}/s  |  ` +
    `V:${g(co,'valid')} ${vwi}2FA:${g(co,'twofa')} BAN:${g(co,'banned')} INV:${g(co,'invalid')} BLK:${g(co,'retry')} ERR:${g(co,'err')}`;
}

// Map a worker result (status + line) to exactly one feed bucket. The worker
// reports coarse status (valid|banned|twofa|invalid|error); we refine 'valid'
// into vwi / 2FA-enabled / plain valid using the result line fields.
function bucketOf(line, status) {
  if (status === 'invalid') return 'invalid';
  if (status === 'error') return /ERROR_RETRY/.test(line || '') ? 'retry' : 'err';
  if (status === 'banned') return 'banned';
  if (status === 'twofa') return 'twofa';
  if (LITE) return 'valid';                  // lite has no VWI sub-classification
  const fb = fmt.feedStatus(line || '');
  if (fb === 'vwi') return 'vwi';
  if (fb === 'twofa') return 'twofa';
  if (fb === 'banned') return 'banned';
  return 'valid';
}

// ── live dashboard (anchored paint, no flicker — mirrors checker.js) ─────────
function paint(state) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  const ctr = (s) => ' '.repeat(Math.max(0, Math.floor((cols - vis(s)) / 2))) + s;
  const co = state.co, done = state.done, total = state.total, cps = state.cps;
  const showArt = ART_SM.length && rows >= ART_SM.length + 18;
  const headH = showArt ? ART_SM.length + 4 : 2;
  const feedMax = Math.max(3, Math.min(16, rows - headH - 8 - 1));
  let out = '\x1b[H\n';
  if (showArt) { for (const l of ART_SM) out += ctr(l) + '\n'; out += '\n'; }
  out += ctr(sky(bold(brand.name)) + dim('  ·  checking')) + '\n\n';
  const pct = total ? Math.min(100, Math.floor(done / total * 100)) : 0;
  const barW = 42, fill = Math.round(pct / 100 * barW);
  out += ctr(sky('█'.repeat(fill)) + dim('░'.repeat(barW - fill)) + '  ' + white(pct + '%')) + '\n';
  out += ctr(dim(`${done.toLocaleString()} / ${total.toLocaleString()}   ·   ${cps}/s   ·   in-flight ${state.conc || 0}${state.phase ? dim(' · ' + state.phase) : ''}   ·   ${state.lat || 0}ms   ·   ETA ${fmtEta(state.eta)}`)) + '\n\n';
  const counters = [green('V ' + g(co, 'valid'))];
  if (!LITE) counters.push(mag('VWI ' + g(co, 'vwi')));
  counters.push(yellow('2FA ' + g(co, 'twofa')), red('BAN ' + g(co, 'banned')),
    dim('INV ' + g(co, 'invalid')), orange('BLK ' + g(co, 'retry')), red('ERR ' + g(co, 'err')));
  out += ctr(counters.join(dim('  ·  '))) + '\n\n';
  out += ctr(state.stopping ? yellow('■ stopping…') : (dim('press ') + sky('S') + dim(' to stop'))) + '\n\n';
  for (const f of state.feed.slice(-feedMax)) out += '   ' + label(f.status) + '  ' + white(f.email) + '\n';
  out += '\x1b[J';
  process.stdout.write(out.replace(/\n/g, '\x1b[K\n'));
}

// ── result classification for the sorter (mirrors website/server) ───────────
function runHeadline(res) {
  if (!res) return red('■ failed');
  const frac = res.total ? dim(` (${Number(res.processed || 0).toLocaleString()}/${Number(res.total).toLocaleString()})`) : '';
  const kind = formatOutcome(res).kind;
  if (kind === 'stalled') return yellow('■ stalled — auto-stopped') + frac;
  if (kind === 'stopped') return yellow('■ stopped') + frac;
  if (kind === 'crashed') return red('■ error — partial') + frac;
  if (kind === 'partial') {
    if (res.pass2Complete === false && res.pass2Total) {
      return orange(`■ partial — pass 2 (${Number(res.pass2Processed || 0).toLocaleString()}/${Number(res.pass2Total).toLocaleString()} hits)`) + frac;
    }
    return orange('■ partial') + frac;
  }
  if (kind === 'failed') return red('■ failed');
  return green('✓ done');
}

function runResumeHint(res, outDir) {
  if (!outDir || !res) return '';
  if (res.complete) return '';
  const why = res.stalled
    ? dim('   speed hit 0 too long — partial saved. ')
    : (res.crashed ? dim('   run ended early — partial saved. ') : dim('   '));
  return why + dim('Continue: menu option ') + sky('2 Resume') + dim(' or ') + sky('--resume') + dim(' ') + sky(outDir);
}

const bannedY   = (l) => /\|\s*Banned:\s*Y\b/i.test(l);
const banUnkY   = (l) => /\|\s*Banned:\s*\?(?:\s|\||$)/i.test(l);
const linkableY = (l) => /XBX|PSN/i.test(fieldOf(l, 'Linkable'));
function isUsableValidL(l) {
  if (/\|\s*PARTIAL(\s|$)/.test(l)) return true;
  if (!l.includes(' | User: ')) return false;
  if (bannedY(l)) return false;
  if (banUnkY(l)) return false;
  return linkableY(l);
}
function isVwiL(l) {
  if (!l.includes(' | User: ') || bannedY(l) || !linkableY(l)) return false;
  const has = (v) => v && v !== '—' && v !== '-';
  return has(fieldOf(l, 'Skins')) || has(fieldOf(l, 'Ranks'));
}
function classifyL(l) {
  if (/\|\s*ERROR_RETRY/.test(l)) return 'blocked';
  if (/\|\s*ERROR_(NETWORK|UNKNOWN)/.test(l)) return 'error';
  if (/\|\s*2FA_REQUIRED/.test(l)) return 'twofa';
  if (/\|\s*INVALID(\s|$)/.test(l)) return 'invalid';
  if (l.includes(' | User: ') || /\|\s*PARTIAL(\s|$)/.test(l)) {
    if (bannedY(l)) return 'banned';
    if (banUnkY(l)) return 'blocked';
    if (isVwiL(l)) return 'vwi';
    if (/\|\s*2FA:\s*Y\b/i.test(l)) return 'twofa';
    if (isUsableValidL(l)) return 'valid';
    return 'other';
  }
  return 'other';
}
// Lite (Ubisoft VM) classifier — the lite line format only ever carries a ban /
// 2FA / error / invalid tag; an untagged email:pass line is a confirmed valid
// (invalids are written to their own file and excluded from results.txt).
function classifyLite(l) {
  if (/\|\s*ERROR_RETRY/.test(l)) return 'blocked';
  if (/\|\s*ERROR_(NETWORK|UNKNOWN)/.test(l)) return 'error';
  if (/\|\s*2FA(_REQUIRED|:\s*Y)/i.test(l)) return 'twofa';
  if (/\|\s*Banned:\s*Y\b/i.test(l)) return 'banned';
  if (/\|\s*INVALID(\s|$)/.test(l)) return 'invalid';
  return /^[^\s:]+:[^\s|]/.test(l) ? 'valid' : 'other';
}

// ── VWI split (each account → its single highest-priority bucket) ────────────
const VWI_PRIORITY = [
  'Champion', 'Diamond',
  'Gold GO4 Charm', 'Silver GO4 Charm',
  'Glacier', 'Black Ice (20+)', 'R4-C Black Ice', 'SMG12 Black Ice', 'Gold Dust',
  'Obsidian', 'El Dorado', 'Crossfader', 'Chroma Streaks', 'Plasma Pink', 'Racer', 'Chupinazo',
  'VIP Invitational', 'Year One Pro League', 'Peacock', 'Fire', 'Dust Line',
  'Emerald', 'Plat',
];
function vwiBucketsOf(line) {
  const have = new Set();
  const rk = fieldOf(line, 'Ranks');
  if (rk && rk !== '—' && rk !== '-') for (const part of rk.split(',')) {
    const t = part.trim().replace(/\s*\(S?\d+\)\s*$/i, '').trim();
    if (t) have.add(t);
  }
  const sk = fieldOf(line, 'Skins');
  if (sk && sk !== '—' && sk !== '-') for (const part of sk.split(',')) {
    const m = part.trim().match(/^(\d+)\s*[x×]?\s*(.+)$/i);
    const name = (m ? m[2] : part).trim();
    if (name) have.add(name);
  }
  return have;
}
function vwiBucketFor(line) {
  const have = vwiBucketsOf(line);
  return VWI_PRIORITY.find(b => have.has(b)) || [...have][0] || null;
}
// VWI hits live in valid.txt (a VWI account's worker status is 'valid'); filter
// them out and split into per-bucket files under <runDir>/vwi/.
function saveVwiSplit(runDir) {
  let txt = '';
  for (const f of ['vwi.txt', 'valid.txt']) {
    try { txt = fs.readFileSync(path.join(runDir, f), 'utf8'); if (txt.trim()) break; } catch {}
  }
  const lines = txt.split(/\r?\n/).filter(l => l.trim() && isVwiL(l));
  if (!lines.length) { console.log('   ' + dim('no VWI hits to save.')); return; }
  const dir = path.join(runDir, 'vwi'); try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const groups = {};
  for (const l of lines) { const b = vwiBucketFor(l); if (b) (groups[b] = groups[b] || []).push(l); }
  const safe = (s) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const ents = Object.entries(groups).sort((a, c) => {
    const ia = VWI_PRIORITY.indexOf(a[0]), ic = VWI_PRIORITY.indexOf(c[0]);
    return (ia < 0 ? 99 : ia) - (ic < 0 ? 99 : ic);
  });
  for (const [name, arr] of ents) { try { fs.writeFileSync(path.join(dir, safe(name) + '.txt'), arr.join('\n') + '\n'); } catch {} }
  console.log('   ' + green('✓ saved ' + lines.length.toLocaleString() + ' VWI hits → ' + ents.length + ' files (no account in two files)'));
  for (const [name, arr] of ents) console.log('     ' + mag('•') + ' ' + white(name.padEnd(20)) + sky(String(arr.length)));
}

// ── menu actions ────────────────────────────────────────────────────────────
const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch { return []; } };
const countAccounts = (baseDir) => readLines(path.join(baseDir, 'accounts.txt')).filter(l => l.includes(':')).length;
const countProxies  = (baseDir) => {
  try { return loadProxies(baseDir).length; }
  catch { return readLines(path.join(baseDir, 'proxies.txt')).filter(l => !l.startsWith('#')).length; }
};

async function startCheck(ctx) {
  const baseDir = ctx.baseDir;
  const input = path.join(baseDir, 'accounts.txt');
  const total0 = countAccounts(baseDir);
  if (!total0) { console.log('\n   ' + red('accounts.txt is empty.') + dim(' Use Import accounts first.')); await ask('   ' + dim('press Enter…')); return null; }

  if (!countProxies(baseDir)) {
    console.log('\n   ' + yellow('! No proxies loaded.') + dim(' Direct checking is rate-limited by Ubisoft (slow + 429).'));
    console.log('   ' + dim('Add rotating residential proxies via ') + sky('Import proxies') + dim(' for full speed.'));
    const go = await ask('\n   ' + dim('start anyway in safe mode? ') + sky('(y/n) › '));
    if (!/^y/i.test(go)) return null;
  }

  clear();
  const usePipeline = !ctx.resumeDir && wantPipeline(total0);
  const useTwoPass = !ctx.resumeDir && !usePipeline && wantTwoPass(total0);
  const useMulti = !ctx.resumeDir && !usePipeline && !useTwoPass && pickProcessCount(total0) > 1;
  const state = {
    feed: [], co: { valid: 0, vwi: 0, twofa: 0, banned: 0, invalid: 0, retry: 0, err: 0 },
    done: 0, total: total0, cps: 0, eta: 0, stopping: false,
    phase: usePipeline ? 'pipeline · sweep+enrich' : (useTwoPass ? 'pass 1 · fast login' : (useMulti ? `mp × ${pickProcessCount(total0)}` : '')),
    conc: 0, lat: 0,
  };
  let stopFn = null;
  let stallNote = null;
  const release = keyControl(() => {
    state.stopping = true;
    restoreStdin();
    if (stopFn) { try { stopFn(); } catch { /* ignore */ } }
  });
  const timer = setInterval(() => paint(state), 250);

  const onSnap = (snap) => {
    if (!snap) return;
    state.done = snap.done;
    if (snap.total) state.total = snap.total;
    state.cps = snap.cps != null ? Math.round(snap.cps) : Math.round((snap.cpm || 0) / 60);
    state.eta = snap.etaSec != null ? snap.etaSec : (state.cps > 0 ? ((state.total - state.done) / state.cps) : 0);
    state.conc = snap.targetWorkers || snap.processes || state.conc;
    state.lat = snap.medianLatencyMs || state.lat;
  };

  const onMpProgress = (snap) => {
    state.co.invalid = snap.invalid;
    state.co.valid = snap.valid;
    state.co.twofa = snap.twofa;
    state.co.banned = snap.banned;
    state.co.err = snap.error;
    onSnap({ done: snap.done, total: snap.total, cps: snap.cps });
  };

  const stallWatch = createStallWatch({
    getDone: () => state.done,
    label: 'menu-check',
    onStall: ({ stalledForMs, done }) => {
      stallNote = `no progress for ${Math.round(stalledForMs / 1000)}s (${done}/${state.total})`;
      state.stopping = true;
      state.phase = 'stalled · stopping';
      restoreStdin();
      if (stopFn) { try { stopFn(); } catch { /* ignore */ } }
    },
  });

  const wrapProgress = (fn) => (snap) => {
    try { stallWatch.bump(snap && snap.done); } catch { /* ignore */ }
    return fn(snap);
  };

  let res;
  let startErr = null;
  try {
    if (usePipeline) {
      res = await runPipeline({
        baseDir, input, licenseKey: ctx.licenseKey, totalLines: total0,
        onProgress: wrapProgress((snap) => {
          state.phase = snap.phase === 'pipeline'
            ? `pipeline · mp×${snap.processes || 1}`
            : 'pipeline · sweep+enrich';
          onMpProgress(snap);
        }),
        onResult: (line, status, snap) => {
          const b = bucketOf(line, status);
          state.co[b] = (state.co[b] || 0) + 1;
          onSnap(snap);
          stallWatch.bump(snap && snap.done);
          const email = String(line || '').split('|')[0].split(':')[0].trim();
          state.feed.push({ email, status: b });
          if (state.feed.length > 80) state.feed.shift();
        },
        onControls: ({ stop }) => { stopFn = stop; },
      });
    } else if (useTwoPass) {
      const { runTwoPass } = require('./twopass');
      res = await runTwoPass({
        baseDir, input, licenseKey: ctx.licenseKey, totalLines: total0,
        onProgress: wrapProgress((snap) => {
          if (snap.phase === 2) state.phase = 'pass 2 · full capture';
          else state.phase = `pass 1 · fast login${snap.processes ? ` · mp×${snap.processes}` : ''}`;
          onMpProgress(snap);
        }),
        onResult: (line, status, snap) => {
          const b = bucketOf(line, status);
          state.co[b] = (state.co[b] || 0) + 1;
          onSnap(snap);
          stallWatch.bump(snap && snap.done);
          const email = String(line || '').split('|')[0].split(':')[0].trim();
          state.feed.push({ email, status: b });
          if (state.feed.length > 80) state.feed.shift();
        },
        onControls: ({ stop }) => { stopFn = stop; },
      });
    } else if (useMulti) {
      const N = pickProcessCount(total0);
      res = await runMultiProcess({
        baseDir, input, licenseKey: ctx.licenseKey, processes: N,
        onProgress: wrapProgress(onMpProgress),
        onControls: ({ stop }) => { stopFn = stop; },
      });
    } else {
      res = await run({
        baseDir, input, licenseKey: ctx.licenseKey, resumeDir: ctx.resumeDir, quiet: true,
        onControls: ({ stop }) => { stopFn = stop; },
        onResult: (line, status, snap) => {
          const b = bucketOf(line, status);
          state.co[b] = (state.co[b] || 0) + 1;
          onSnap(snap);
          stallWatch.bump(snap && snap.done);
          const email = String(line || '').split('|')[0].split(':')[0].trim();
          state.feed.push({ email, status: b });
          if (state.feed.length > 80) state.feed.shift();
        },
      });
    }
  } catch (e) {
    startErr = e;
  } finally {
    stallWatch.stop();
    clearInterval(timer);
    release();
    restoreStdin();
  }

  const outDirEarly = res && res.outDir;
  if (outDirEarly) commitPartialFiles(outDirEarly);

  if (startErr) {
    console.log();
    console.log('   ' + red('■ Start check failed: ') + white(startErr.message || String(startErr)));
    if (startErr.stack) console.log(dim(String(startErr.stack).split('\n').slice(0, 8).join('\n')));
    await ask('   ' + dim('press Enter for menu…'));
    return null;
  }
  if (stallNote || (res && res.stalled)) {
    console.log();
    console.log('   ' + yellow('■ stalled — auto-stopped: ') + white(stallNote || res.reason || 'no progress'));
    console.log('   ' + dim('This is NOT a crash — Ubisoft/proxy stalled. Partial results saved.'));
  }
  // Propagate stall onto result for headline/resume.
  if (res && stallNote && !res.stalled) {
    res = { ...res, stalled: true, stopped: true, crashed: false, reason: stallNote, partial: true, complete: false };
  }
  paint(state);
  setTitle(titleStr(state.co, state.done, state.total, 0, 0));

  const outDir = res && res.outDir;
  console.log();
  console.log('   ' + dim('─'.repeat(46)));
  const summary = [green(g(state.co, 'valid') + ' valid')];
  if (!LITE) summary.push(mag(g(state.co, 'vwi') + ' VWI'));
  summary.push(yellow(g(state.co, 'twofa') + ' 2FA'), red(g(state.co, 'banned') + ' ban'),
    dim(g(state.co, 'invalid') + ' inv'), orange(g(state.co, 'retry') + ' blk'), red(g(state.co, 'err') + ' err'));
  console.log('   ' + runHeadline(res) + dim('   ·   ') + summary.join(dim(' · ')));
  if (outDir) console.log('   ' + dim('saved → ') + sky(outDir) + dim('  (results.txt · valid.txt · 2fa.txt · banned.txt · invalid.txt)'));
  const resumeHint = runResumeHint(res, outDir);
  if (resumeHint) console.log('   ' + resumeHint);

  // Upload the run (finished OR stopped) to the user's website Bulk Jobs so it's
  // downloadable from the web. Best-effort: silent skip when offline / owner key.
  if (outDir) {
    const resultsFile = path.join(outDir, 'results.txt');
    try {
      if (fs.existsSync(resultsFile) && fs.statSync(resultsFile).size > 0) {
        process.stdout.write('   ' + dim('☁ saving to your web jobs… '));
        const up = await cp.uploadResults(ctx.licenseKey, resultsFile, { stopped: !!(res && (res.stopped || res.partial || res.crashed)) });
        if (up.ok) console.log(green('done') + dim('  → ') + sky((up.url || 'https://r6checker.xyz/bulk')) + dim('  (' + (up.total || 0).toLocaleString() + ' lines)'));
        else console.log(dim('skipped (' + (up.reason || 'offline') + ') — local files saved'));
      }
    } catch (e) { console.log(dim('   web save skipped: ' + e.message)); }
  }
  console.log();
  if (!LITE && g(state.co, 'vwi') > 0 && outDir) {
    const ans = await ask('   ' + mag('★ ' + g(state.co, 'vwi') + ' VWI hit' + (g(state.co, 'vwi') === 1 ? '' : 's') + ' found.') + dim('  save split by item/rank? ') + sky('(y/n) › '));
    if (/^y/i.test(ans)) { console.log(); saveVwiSplit(outDir); }
    console.log();
  }
  await ask('   ' + dim('press Enter for menu…'));
  return outDir || null;
}

// Import any email:pass file → merge/replace accounts.txt (deduped).
async function importAccounts(baseDir) {
  const raw = await ask('   ' + dim('drag a file here or paste its path') + sky(' › '));
  const p = raw.replace(/^["']|["']$/g, '').trim();
  if (!p) return;
  let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { console.log('   ' + red('could not read: ' + e.message)); return; }
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(l => /^[^\s:]+:[^\s]/.test(l));
  if (!lines.length) { console.log('   ' + red('no email:password lines found in that file.')); return; }
  const dest = path.join(baseDir, 'accounts.txt');
  const existing = readLines(dest);
  const mode = (await ask('   ' + dim('found ' + lines.length.toLocaleString() + ' accounts · ') + sky('[M]') + dim('erge with ' + existing.length.toLocaleString() + ' existing or ') + sky('[R]') + dim('eplace? '))).trim().toLowerCase();
  if (mode === 'r' || mode === 'replace') {
    const fresh = Array.from(new Set(lines));
    fs.writeFileSync(dest, fresh.join('\n') + '\n');
    console.log('   ' + green('✓') + dim(' replaced → accounts.txt (' + fresh.length.toLocaleString() + ' accounts)'));
  } else {
    const merged = Array.from(new Set([...existing, ...lines]));
    console.log('   ' + green('✓') + dim(' merged ' + lines.length.toLocaleString() + ' → accounts.txt (' + merged.length.toLocaleString() + ' total, ' + (existing.length + lines.length - merged.length).toLocaleString() + ' dupes removed)'));
    fs.writeFileSync(dest, merged.join('\n') + '\n');
  }
}

// Import a proxy list → merge/replace proxies.txt (deduped). Accepts any
// host:port[:user:pass] or http(s):// line.
async function importProxies(baseDir) {
  const raw = await ask('   ' + dim('drag a proxy file here or paste its path') + sky(' › '));
  const p = raw.replace(/^["']|["']$/g, '').trim();
  if (!p) return;
  let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { console.log('   ' + red('could not read: ' + e.message)); return; }
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length) { console.log('   ' + red('no proxies found in that file.')); return; }
  const dest = path.join(baseDir, 'proxies.txt');
  const existing = readLines(dest);
  const mode = (await ask('   ' + dim('found ' + lines.length.toLocaleString() + ' proxies · ') + sky('[M]') + dim('erge with ' + existing.length.toLocaleString() + ' existing or ') + sky('[R]') + dim('eplace? '))).trim().toLowerCase();
  if (mode === 'r' || mode === 'replace') {
    const fresh = Array.from(new Set(lines));
    fs.writeFileSync(dest, fresh.join('\n') + '\n');
    console.log('   ' + green('✓') + dim(' replaced → proxies.txt (' + fresh.length.toLocaleString() + ' proxies)'));
  } else {
    const merged = Array.from(new Set([...existing, ...lines]));
    console.log('   ' + green('✓') + dim(' merged → proxies.txt (' + merged.length.toLocaleString() + ' proxies)'));
    fs.writeFileSync(dest, merged.join('\n') + '\n');
  }
}

// Sorter — split a results file into category files (same as the website's
// download buttons). Every line lands in exactly one bucket.
async function sortResults(baseDir) {
  const here = (f) => path.isAbsolute(f) ? f : path.join(baseDir, f);
  const def = fs.existsSync(here('results.txt')) ? 'results.txt' : '';
  const raw = await ask('   ' + dim('file to sort' + (def ? ' [' + def + ']' : '') + ' — drag/paste path') + sky(' › '));
  let p = (raw.replace(/^["']|["']$/g, '').trim()) || def;
  if (!p) { console.log('   ' + red('no file given.')); return; }
  if (!path.isAbsolute(p) && !fs.existsSync(p)) p = here(p);
  let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { console.log('   ' + red('could not read: ' + e.message)); return; }
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  const b = { valid: [], vwi: [], twofa: [], banned: [], invalid: [], blocked: [], error: [], other: [] };
  const skinTally = {}, rankTally = {};

  // Lite (Ubisoft VM): only valid / invalid / 2fa / banned (+ blocked/error).
  // No skins/ranks/VWI to tally.
  if (LITE) {
    for (const l of lines) b[classifyLite(l)].push(l);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = path.join(baseDir, 'sorted', stamp);
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
    const files = { 'valid.txt': 'valid', '2fa.txt': 'twofa', 'banned.txt': 'banned', 'invalid.txt': 'invalid', 'blocked.txt': 'blocked', 'errors.txt': 'error' };
    for (const [f, k] of Object.entries(files)) { try { fs.writeFileSync(path.join(outDir, f), b[k].length ? b[k].join('\n') + '\n' : ''); } catch {} }
    console.log();
    console.log('   ' + green('✓ sorted ' + lines.length.toLocaleString() + ' lines') + dim('  → ') + sky(outDir) + dim('  (none skipped)'));
    const row = (lbl, arr, col) => console.log('     ' + col(lbl.padEnd(9)) + white(arr.length.toLocaleString()));
    row('valid', b.valid, green); row('2fa', b.twofa, yellow); row('banned', b.banned, red);
    row('invalid', b.invalid, dim); row('blocked', b.blocked, orange); row('error', b.error, red);
    return;
  }

  for (const l of lines) {
    const cat = classifyL(l);
    b[cat].push(l);
    if (cat === 'valid' || cat === 'vwi' || cat === 'twofa' || cat === 'banned') {
      const sk = fieldOf(l, 'Skins');
      if (sk && sk !== '—' && sk !== '-') for (const part of sk.split(',')) {
        const m = part.trim().match(/^(\d+)\s*[x×]?\s*(.+)$/i);
        if (m) skinTally[m[2].trim()] = (skinTally[m[2].trim()] || 0) + parseInt(m[1], 10);
        else if (part.trim()) skinTally[part.trim()] = (skinTally[part.trim()] || 0) + 1;
      }
      const rk = fieldOf(l, 'Ranks');
      if (rk && rk !== '—' && rk !== '-') for (const part of rk.split(',')) {
        const tier = part.trim().replace(/\s*\(S?\d+\)\s*$/i, '').trim();
        if (tier) rankTally[tier] = (rankTally[tier] || 0) + 1;
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(baseDir, 'sorted', stamp);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const files = { 'valid.txt': 'valid', 'vwi.txt': 'vwi', '2fa.txt': 'twofa', 'banned.txt': 'banned', 'invalid.txt': 'invalid', 'blocked.txt': 'blocked', 'errors.txt': 'error' };
  for (const [f, k] of Object.entries(files)) { try { fs.writeFileSync(path.join(outDir, f), b[k].length ? b[k].join('\n') + '\n' : ''); } catch {} }
  console.log();
  console.log('   ' + green('✓ sorted ' + lines.length.toLocaleString() + ' lines') + dim('  → ') + sky(outDir) + dim('  (none skipped)'));
  const row = (lbl, arr, col) => console.log('     ' + col(lbl.padEnd(9)) + white(arr.length.toLocaleString()));
  row('valid', b.valid, green); row('vwi', b.vwi, mag); row('2fa', b.twofa, yellow); row('banned', b.banned, red);
  row('invalid', b.invalid, dim); row('blocked', b.blocked, orange); row('error', b.error, red); row('unlinkable', b.other, dim);
  const dumpTally = (title, tally, col) => {
    const ents = Object.entries(tally).filter(([, n]) => n > 0).sort((a, c) => c[1] - a[1]);
    console.log();
    console.log('   ' + bold(col(title)) + dim(ents.length ? '' : '  none'));
    for (const [name, n] of ents) console.log('     ' + col('•') + ' ' + white(name.padEnd(20)) + sky(String(n)));
  };
  dumpTally('Wanted ranks', rankTally, yellow);
  dumpTally('Ranked skins', skinTally, mag);
  // Also split the VWI hits by item/rank, like the old exe did automatically.
  if (b.vwi.length) { try { fs.writeFileSync(path.join(outDir, 'vwi.txt'), b.vwi.join('\n') + '\n'); saveVwiSplit(outDir); } catch {} }
}

// ── main menu loop ──────────────────────────────────────────────────────────
function findLatestRunDir(baseDir) {
  try {
    const out = path.join(baseDir, 'output');
    if (!fs.existsSync(out)) return null;
    const dirs = fs.readdirSync(out).filter((n) => n.startsWith('run_')).sort();
    if (!dirs.length) return null;
    return path.join(out, dirs[dirs.length - 1]);
  } catch { return null; }
}

async function runMenu({ licenseKey, account, baseDir }) {
  ART_LINES = loadArt('art', 'art.txt', baseDir);
  ART_SM    = loadArt('art-sm', 'art-sm.txt', baseDir);
  setTitle(brand.title + '  ·  ' + brand.subtitle);
  let lastOut = findLatestRunDir(baseDir);
  for (;;) {
    splash(account);
    console.log(accessLine(account));
    const accts = countAccounts(baseDir), px = countProxies(baseDir);
    console.log('   ' + dim('accounts: ') + (accts ? white(accts.toLocaleString()) : red('0 — Import accounts')) +
                dim('   proxies: ') + (px ? green(px) : red('0 — Import proxies')));
    console.log();
    console.log('   ' + sky('1') + '   Start check        ' + dim('accounts.txt · auto fast mode on 5k+ lines'));
    if (lastOut) console.log('   ' + sky('2') + '   Resume remaining   ' + dim(lastOut));
    console.log('   ' + sky('3') + '   Import accounts    ' + dim('from any email:pass file'));
    console.log('   ' + sky('4') + '   Import proxies     ' + dim('rotating residential · Flame / DataImpulse / Nova / Core'));
    console.log('   ' + sky('5') + '   Sort results       ' + dim(LITE ? 'split into valid · 2fa · banned · invalid' : 'split into valid · vwi · 2fa · banned · invalid …'));
    console.log('   ' + sky('6') + '   Exit');
    const ch = await ask('\n   ' + dim('select ') + sky('› '));
    try {
      if (ch === '1') { const o = await startCheck({ licenseKey, baseDir }); if (o) lastOut = o; }
      else if (ch === '2' && lastOut) { const o = await startCheck({ licenseKey, baseDir, resumeDir: lastOut }); if (o) lastOut = o; }
      else if (ch === '3') { await importAccounts(baseDir); await ask('   ' + dim('press Enter…')); }
      else if (ch === '4') { await importProxies(baseDir); await ask('   ' + dim('press Enter…')); }
      else if (ch === '5') { await sortResults(baseDir); console.log(); await ask('   ' + dim('press Enter…')); }
      else if (ch === '6') { process.exit(0); }
    } catch (e) {
      console.log();
      console.log('   ' + red('■ Error: ') + white(e && e.message ? e.message : String(e)));
      await ask('   ' + dim('press Enter…'));
    }
  }
}

module.exports = { runMenu, _internal: { bucketOf, classifyL, vwiBucketFor, isVwiL } };
