'use strict';
// Resolve output bucket paths — finalized file or in-progress .part sibling.

const fs = require('fs');
const path = require('path');

const BUCKETS = ['valid.txt', 'invalid.txt', '2fa.txt', 'banned.txt', 'errors.txt', 'results.txt'];

function resolveBucketPath(dir, fileName) {
  const finalPath = path.join(dir, fileName);
  const partPath = finalPath + '.part';
  if (fs.existsSync(finalPath)) return finalPath;
  if (fs.existsSync(partPath)) return partPath;
  return null;
}

/** Rename every *.part in dir to its final name (best-effort, idempotent). */
function commitPartialFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of BUCKETS) {
    const partPath = path.join(dir, f + '.part');
    const finalPath = path.join(dir, f);
    if (!fs.existsSync(partPath)) continue;
    try {
      if (fs.existsSync(finalPath)) {
        const extra = fs.readFileSync(partPath, 'utf8');
        if (extra.trim()) fs.appendFileSync(finalPath, extra.endsWith('\n') ? extra : extra + '\n');
        fs.unlinkSync(partPath);
      } else {
        fs.renameSync(partPath, finalPath);
      }
      n++;
    } catch { /* ignore */ }
  }
  return n;
}

module.exports = { BUCKETS, resolveBucketPath, commitPartialFiles };
