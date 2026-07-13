// Build the local-distributed R6Checker.exe via Node SEA.
//
// Unlike the old thin-client build, this app has real dependencies and spawns
// worker_threads. SEA has no separate worker file, so the worker is bundled into
// a self-contained string and embedded as a SEA asset ("check-worker"), which
// the runner loads with new Worker(code, { eval: true }).
//
//   node build-local.js   →   dist/R6Checker.exe
//
// Requires Node 20.10+ (SEA assets) — newer is better.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const D = __dirname;
// Override the output dir (R6_OUT_DIR) when dist/<exe> is locked by a running
// instance — build to a temp dir, then ship that to the website to re-download.
const OUT = process.env.R6_OUT_DIR ? path.resolve(process.env.R6_OUT_DIR) : path.join(D, 'dist');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Brand select (R6_BRAND=ubivm → Ubisoft VM login validator, else R6Checker).
// One codebase, two exes — the brand is BAKED into the bundle via esbuild
// `define`, so the same main/worker source produces different behavior + name.
const BRANDS = {
  // Both exes share the same icon (cli/icon.ico).
  r6checker: { exe: 'R6Checker.exe', label: 'R6Checker', icon: 'icon.ico' },
  ubivm:     { exe: 'UbisoftVM.exe', label: 'Ubisoft VM', icon: 'icon.ico' },
};
const BRAND_ID = (process.env.R6_BRAND || 'r6checker').toLowerCase();
const BRAND = BRANDS[BRAND_ID] || BRANDS.r6checker;
const EXE = path.join(OUT, BRAND.exe);

function run(cmd, args) {
  const r = cp.spawnSync(cmd, args, { cwd: D, stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`);
}

// Obfuscate a bundled JS file before SEA injection (pkg-compatible profile —
// no selfDefending/debugProtection; those break V8 bytecode snapshots).
function obfuscateBundle(filePath) {
  const JO = require('javascript-obfuscator');
  const src = fs.readFileSync(filePath, 'utf8');
  const out = JO.obfuscate(src, {
    compact: true,
    simplify: true,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    stringArrayWrappersType: 'variable',
    transformObjectKeys: true,
    numbersToExpressions: false,
    unicodeEscapeSequence: false,
    reservedStrings: [
      '^node:sea$', '^worker_threads$', '^fs$', '^path$', '^os$', '^crypto$',
      '^http$', '^https$', '^child_process$', '^readline$',
    ],
  }).getObfuscatedCode();
  fs.writeFileSync(filePath, out);
  console.log(`  ✓ obfuscated ${path.basename(filePath)} (${Math.round(out.length / 1024)} KB)`);
}

(async () => {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) throw new Error(`Node 20.10+ required for SEA assets (have ${process.versions.node}).`);
  console.log(`• brand: ${BRAND.label} → ${BRAND.exe}`);

  const esbuild = require('esbuild');
  const common = {
    bundle: true, platform: 'node', target: 'node20', legalComments: 'none',
    // Bake the brand into the bundle so cli/local/brand.js resolves it at
    // build time (process.env.R6_BRAND is replaced with the literal here).
    define: { 'process.env.R6_BRAND': JSON.stringify(BRAND_ID) },
    // node:sea is a builtin namespace — never bundle it.
    // trackerBrowser + camoufox + playwright + impit + cycletls are server-only
    // (browser TLS / real-browser bypass for tracker.gg). The desktop worker
    // sets R6_NO_TRACKER=1 so these code paths never execute — but esbuild
    // follows static requires anyway, so we mark them external. They'd fail to
    // resolve at runtime if reached; the env flag guarantees we don't.
    external: [
      'node:sea',
      './trackerBrowser', '../lib/trackerBrowser', '../../lib/trackerBrowser',
      'camoufox-js', 'playwright-core', 'impit',
      'cycletls', './cycletlsClient', '../lib/cycletlsClient', '../../lib/cycletlsClient',
    ],
  };

  // 1) Bundle the worker into a self-contained string (https-proxy-agent inlined).
  console.log('• bundling worker (check-worker.js)…');
  await esbuild.build({ ...common, entryPoints: [path.join(D, 'local', 'check-worker.js')], outfile: path.join(D, 'worker.bundle.js') });

  // 2) Bundle the main app.
  console.log('• bundling main app (main.js)…');
  await esbuild.build({ ...common, entryPoints: [path.join(D, 'local', 'main.js')], outfile: path.join(D, 'main.bundle.js') });

  if (process.env.R6_SKIP_OBFUSCATE !== '1') {
    console.log('• obfuscating bundles…');
    obfuscateBundle(path.join(D, 'worker.bundle.js'));
    obfuscateBundle(path.join(D, 'main.bundle.js'));
  }

  // 3) Generate the SEA blob (embeds main + the worker asset).
  console.log('• generating SEA blob…');
  run(process.execPath, ['--experimental-sea-config', 'sea-config-local.json']);

  // 4) Copy node → exe and inject the blob.
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(process.execPath, EXE);
  const { inject } = require('postject');
  await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(path.join(D, 'sea-prep.blob')), { sentinelFuse: FUSE });
  console.log('✓ SEA blob injected');

  // 5) Icon (resedit drops the cert but preserves the blob; verify it still runs).
  const brandIco = path.join(D, BRAND.icon || 'icon.ico');
  const ico = fs.existsSync(brandIco) ? brandIco : path.join(D, 'icon.ico');
  console.log(`• icon: ${path.basename(ico)}`);
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
      const r = cp.spawnSync(EXE, ['--help'], { timeout: 8000, input: '', encoding: 'utf8' });
      if (((r.stdout || '') + (r.stderr || '')).match(/R6Checker|Usage/i)) console.log('✓ icon set & verified');
      else { fs.writeFileSync(EXE, before); console.log('! icon broke the exe — reverted (no icon).'); }
    } catch (e) { fs.writeFileSync(EXE, before); console.log('! icon step skipped (' + e.message + ')'); }
  }

  // 6) Cleanup intermediates.
  for (const f of ['sea-prep.blob', 'main.bundle.js', 'worker.bundle.js']) { try { fs.unlinkSync(path.join(D, f)); } catch {} }

  console.log(`✓ built ${path.relative(process.cwd(), EXE)} (${(fs.statSync(EXE).size / 1048576).toFixed(0)} MB)`);
})().catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
