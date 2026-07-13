'use strict';
// Result writer — streams classified lines to per-bucket files with proper
// backpressure handling and atomic finalize.
//
// Backpressure: when stream.write() returns false the OS buffer is full; we
// await the 'drain' event before continuing so memory can't balloon on a slow
// disk. Each bucket writes to a .part file that is atomically renamed to its
// final name on close, so a crash never leaves a half-written "final" file.

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { commitPartialFiles } = require('./outputFiles');

class ResultWriter {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._streams = new Map(); // bucket -> { stream, partPath, finalPath, draining }
  }

  _stream(bucket, fileName) {
    let s = this._streams.get(bucket);
    if (!s) {
      const finalPath = path.join(this.dir, fileName);
      const partPath = finalPath + '.part';
      const stream = fs.createWriteStream(partPath, { flags: 'a', highWaterMark: config.output.highWaterMark });
      s = { stream, partPath, finalPath, drainPromise: null };
      stream.on('error', (e) => { s.error = e; });
      this._streams.set(bucket, s);
    }
    return s;
  }

  // Write a line to a bucket, honoring backpressure. Returns a promise that
  // resolves once the line is accepted (immediately, or after 'drain').
  async write(bucket, fileName, line) {
    const s = this._stream(bucket, fileName);
    if (s.error) throw s.error;
    // If a drain is already pending, wait for it before queueing more.
    if (s.drainPromise) await s.drainPromise;
    const ok = s.stream.write(line.endsWith('\n') ? line : line + '\n');
    if (!ok) {
      // Buffer full → apply backpressure until 'drain'.
      s.drainPromise = new Promise((resolve) => s.stream.once('drain', () => { s.drainPromise = null; resolve(); }));
      await s.drainPromise;
    }
  }

  // Flush + atomically rename every .part → final. Call once at the end.
  async finalize() {
    for (const s of this._streams.values()) {
      await new Promise((resolve) => s.stream.end(resolve));
      try {
        if (fs.existsSync(s.partPath)) fs.renameSync(s.partPath, s.finalPath);
      } catch { /* leave the .part if rename fails — data is still there */ }
    }
    // Belt-and-suspenders: commit any stray .part files in this run dir.
    commitPartialFiles(this.dir);
  }

  // End streams then commit .part → final so partial/stopped runs still have
  // readable valid.txt / results.txt (not invisible .part siblings).
  async flushPartial() {
    for (const s of this._streams.values()) {
      await new Promise((resolve) => s.stream.end(resolve)).catch(() => {});
    }
    commitPartialFiles(this.dir);
  }
}

module.exports = { ResultWriter };
