// Build R6Checker.exe via Node SEA (single executable) — works without pkg's
// base binaries (uses the local node), and sets the icon RELIABLY with
// resedit-js (drops the cert, preserves the SEA blob). Output: dist/R6Checker.exe
//
//   node build-sea.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const D = __dirname;
const exe = path.join(D, 'dist', 'R6Checker.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(cmd, args) {
  const r = cp.spawnSync(cmd, args, { cwd: D, stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ' → exit ' + r.status);
}

(async () => {
  // 1) obfuscate -> checker.obf.js
  require('./build.js');
  // 2) generate the SEA blob (no shell — exec path / cwd have spaces)
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
  // 3) copy the running node into dist
  fs.mkdirSync(path.join(D, 'dist'), { recursive: true });
  fs.copyFileSync(process.execPath, exe);
  // 4) inject the blob via postject's JS API (no shell/path-splitting issues)
  const { inject } = require('postject');
  await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(D, 'sea-prep.blob')), { sentinelFuse: FUSE });
  console.log('✓ SEA blob injected');
  // 5) set the icon with resedit (drops cert, keeps the blob); verify + revert
  const ico = path.join(D, 'icon.ico');
  if (fs.existsSync(ico)) {
    const before = fs.readFileSync(exe);
    try {
      const ResEdit = require('resedit');
      const ne = ResEdit.NtExecutable.from(before, { ignoreCert: true });
      const res = ResEdit.NtExecutableResource.from(ne);
      const icon = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map(i => i.data));
      res.outputResource(ne);
      fs.writeFileSync(exe, Buffer.from(ne.generate()));
      const r = cp.spawnSync(exe, [], { timeout: 6000, input: '', encoding: 'utf8' });
      if (((r.stdout || '') + (r.stderr || '')).includes('R6Checker')) console.log('✓ icon set & verified');
      else { fs.writeFileSync(exe, before); console.log('! icon broke the exe — reverted (no icon).'); }
    } catch (e) { fs.writeFileSync(exe, before); console.log('! icon step failed (' + e.message + ') — kept working build.'); }
  } else {
    console.log('! icon.ico not found — building without an icon. Create it: npx png-to-ico ..\\public\\img\\logo.png > icon.ico');
  }
  try { fs.unlinkSync(path.join(D, 'sea-prep.blob')); } catch {}
  console.log('✓ built dist/R6Checker.exe (' + Math.round(fs.statSync(exe).size / 1048576) + ' MB)');
})().catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
