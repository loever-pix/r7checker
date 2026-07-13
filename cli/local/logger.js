'use strict';
// Tiny leveled logger with timestamps + ANSI colors. Writes human lines to the
// console and (optionally) appends structured JSON lines to a log file so a run
// can be diagnosed after the fact. Safe on Windows/macOS/Linux.

const fs = require('fs');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m', reset: '\x1b[0m' };

let threshold = LEVELS.info;
let fileStream = null;
// File gets EVERY info/warn/error regardless of console threshold. The menu
// mode silences console output (quiet=true) so the operator sees a clean
// dashboard — but when a run mysteriously stalls, run.log MUST have enough
// to diagnose. Without this, quiet-mode produced an empty run.log and the
// user had no signal that, e.g., proxies failed the pre-flight probe.
const fileThreshold = LEVELS.info;

function setLevel(name) {
  if (name in LEVELS) threshold = LEVELS[name];
}

function attachFile(filePath) {
  try {
    fileStream = fs.createWriteStream(filePath, { flags: 'a' });
    fileStream.on('error', () => { fileStream = null; });
  } catch { fileStream = null; }
}

function ts() {
  return new Date().toISOString();
}

function emit(level, msg, meta) {
  // File capture is independent of the console threshold so the log file
  // remains diagnosable even in quiet (menu) mode.
  if (fileStream && LEVELS[level] <= fileThreshold) {
    try { fileStream.write(JSON.stringify({ t: ts(), level, msg, ...(meta || {}) }) + '\n'); } catch {}
  }
  if (LEVELS[level] > threshold) return;
  const line = `${COLORS[level]}[${ts()}] ${level.toUpperCase().padEnd(5)}${COLORS.reset} ${msg}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  setLevel, attachFile,
  error: (m, meta) => emit('error', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  info: (m, meta) => emit('info', m, meta),
  debug: (m, meta) => emit('debug', m, meta),
  close: () => { try { fileStream && fileStream.end(); } catch {} },
};
