const assert = require('assert');
const updater = require('../cli/local/updater');

{
  assert.strictEqual(updater.compareVersions('2.0.1', '2.0.0') > 0, true);
  assert.strictEqual(updater.compareVersions('2.0.0', '2.0.0'), 0);
  assert.strictEqual(updater.compareVersions('2.0.0', '2.0.1') < 0, true);
}

{
  const plan = updater.buildWindowsInstallPlan({
    currentExe: 'C:\\Apps\\R6Checker.exe',
    downloadedExe: 'C:\\Users\\Brandon\\AppData\\Local\\Temp\\R6Checker-update.exe',
    argv: ['--input', 'C:\\Users\\Brandon\\accounts.txt'],
    pid: 1234,
  });
  assert.strictEqual(plan.command, 'powershell.exe');
  assert.ok(plan.args.includes('-STA'));
  const script = plan.args[plan.args.length - 1];
  assert.match(script, /Wait-Process -Id 1234/);
  assert.match(script, /Move-Item -LiteralPath/);
  assert.match(script, /Start-Process -FilePath/);
  assert.match(script, /--input/);
  assert.match(script, /accounts\.txt/);
}

{
  const result = updater.normalizeUpdateInfo({
    currentVersion: '2.0.0',
    update: { updateAvailable: true, latest: '2.0.1', url: '/downloads/R6Checker.exe' },
    baseUrl: 'https://r6checker.xyz',
  });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, '2.0.1');
  assert.strictEqual(result.url, 'https://r6checker.xyz/downloads/R6Checker.exe');
}

console.log('desktop updater tests passed');
