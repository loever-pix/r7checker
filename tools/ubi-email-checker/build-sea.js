// Build ubi-email-checker.exe via Node SEA (single executable application).
//
// Why SEA and not pkg: pkg downloads prebuilt base binaries from a registry that
// isn't always reachable, and chokes on modern Node. SEA uses the LOCAL node you
// already have, bundles every dependency (axios, proxy agents, chalk, …) into one
// CJS file via esbuild, injects it as a blob, and emits a standalone .exe that
// needs no Node install on the target machine. Same end result pkg promises.
//
//   npm install      (once, to get esbuild + postject + the runtime deps)
//   npm run build    → dist/ubi-email-checker.exe
//
// Requires Node 20+ (SEA is stable there).

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const D = __dirname;
const OUT_DIR = path.join(D, 'dist');
const EXE = path.join(OUT_DIR, 'ubi-email-checker.exe');
const BUNDLE = path.join(D, 'checker.bundle.js');
const BLOB = path.join(D, 'sea-prep.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(cmd, args) {
  const r = cp.spawnSync(cmd, args, { cwd: D, stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`);
}

(async () => {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) throw new Error(`Node 20+ required for SEA (you have ${process.versions.node}).`);

  // 1) Bundle everything into a single CJS file (inlines all node_modules).
  console.log('• bundling with esbuild…');
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [path.join(D, 'checker.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: BUNDLE,
    legalComments: 'none',
    minify: false,
  });

  // 2) Generate the SEA blob from the bundle.
  console.log('• generating SEA blob…');
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

  // 3) Copy the running node binary as the exe base.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, EXE);

  // 4) Inject the blob (postject JS API — no shell/path-with-spaces issues).
  console.log('• injecting blob…');
  const { inject } = require('postject');
  await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), { sentinelFuse: FUSE });

  // 5) Optional icon (icon.ico next to this script). resedit drops the cert but
  //    preserves the SEA blob; verify the exe still runs, else revert.
  const ico = path.join(D, 'icon.ico');
  if (fs.existsSync(ico)) {
    const before = fs.readFileSync(EXE);
    try {
      const ResEdit = require('resedit');
      const ne = ResEdit.NtExecutable.from(before, { ignoreCert: true });
      const res = ResEdit.NtExecutableResource.from(ne);
      const icon = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map((i) => i.data));
      res.outputResource(ne);
      fs.writeFileSync(EXE, Buffer.from(ne.generate()));
      console.log('✓ icon set');
    } catch (e) {
      fs.writeFileSync(EXE, before);
      console.log('! icon step skipped (' + e.message + ')');
    }
  }

  // 6) Cleanup intermediates.
  try { fs.unlinkSync(BLOB); } catch {}
  try { fs.unlinkSync(BUNDLE); } catch {}

  const mb = (fs.statSync(EXE).size / 1048576).toFixed(0);
  console.log(`✓ built ${path.relative(process.cwd(), EXE)} (${mb} MB)`);
  console.log('  Drop a proxies.txt next to it (optional) and run it.');
})().catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
