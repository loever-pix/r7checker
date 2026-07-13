const assert = require('assert');
const path = require('path');
const main = require('../cli/local/main');

{
  const calls = [];
  const selected = main.resolveInputFile({
    args: { _: [] },
    baseDir: 'C:\\app',
    exists: (p) => p === 'C:\\Users\\Brandon\\accounts.txt',
    hasAccounts: () => false,
    pickAccountFile: () => 'C:\\Users\\Brandon\\accounts.txt',
    info: (msg) => calls.push(msg),
  });
  assert.strictEqual(selected, 'C:\\Users\\Brandon\\accounts.txt');
  assert.ok(calls.some(msg => /Import accounts/i.test(msg)));
}

{
  const selected = main.resolveInputFile({
    args: { _: [] },
    baseDir: 'C:\\app',
    exists: () => true,
    hasAccounts: () => true,
    pickAccountFile: () => {
      throw new Error('file picker should not open');
    },
    info: () => {},
  });
  assert.strictEqual(selected, path.join('C:\\app', 'accounts.txt'));
}

{
  const selected = main.resolveInputFile({
    args: { input: 'C:\\custom\\accounts.txt', _: [] },
    baseDir: 'C:\\app',
    exists: () => true,
    hasAccounts: () => false,
    pickAccountFile: () => {
      throw new Error('explicit input should not open picker');
    },
    info: () => {},
  });
  assert.strictEqual(selected, 'C:\\custom\\accounts.txt');
}

{
  const command = main.accountFilePickerCommand('win32');
  assert.strictEqual(command.command, 'powershell.exe');
  assert.ok(command.args.some(arg => /Import accounts/.test(arg)));
  assert.ok(command.args.some(arg => /OpenFileDialog/.test(arg)));
  assert.ok(command.args.some(arg => /Account files/.test(arg)));
}

console.log('desktop account import tests passed');
