// Obfuscate checker.js -> checker.obf.js with a strong profile that is also
// compatible with `pkg` (which compiles the result to a V8 BYTECODE snapshot —
// the JS source never ships in the exe, which is the primary protection).
//
// NOTE: selfDefending / debugProtection / controlFlowFlattening are DISABLED on
// purpose: they rely on Function.prototype.toString, which pkg's bytecode
// snapshot strips, causing "Fatal JavaScript invalid size error". Name + string
// (base64) mangling on top of pkg bytecode is the right, working combo.

const fs = require('fs');
const path = require('path');
const JO = require('javascript-obfuscator');

const src = fs.readFileSync(path.join(__dirname, 'checker.js'), 'utf8');
const result = JO.obfuscate(src, {
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.8,
  stringArrayWrappersType: 'variable',
  transformObjectKeys: true,
  numbersToExpressions: false,
  unicodeEscapeSequence: false,
  // keep built-in module names as literals so pkg can resolve require()
  reservedStrings: ['^https$', '^http$', '^fs$', '^os$', '^path$', '^crypto$', '^readline$', '^child_process$', '^cmd$', '^bash$'],
}).getObfuscatedCode();

fs.writeFileSync(path.join(__dirname, 'checker.obf.js'), result);
console.log('✓ obfuscated → checker.obf.js (' + Math.round(result.length / 1024) + ' KB)');
