// Confirm the XSS-safe JSON inlining used in /profile/:userId.
const malicious = {
  username: 'x</script><script>alert(1)</script>y',
  items: [
    { name: 'normal <!-- bad' },
    { name: 'foo ]]> bar' },
    { name: 'nested </ScRiPt > weird' },
  ],
};

// Build the line-separator regex via RegExp constructor — regex LITERALS
// can't contain raw U+2028/U+2029 (they're parsed as line terminators), but
// the constructor accepts them in the source string. String.fromCharCode
// avoids putting the raw chars in this file at all.
const LSEP_RE = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const toUnicode = c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');

const safeJson = JSON.stringify(malicious)
  .replace(/[<>&]/g, toUnicode)
  .replace(LSEP_RE,  toUnicode);

console.log('safeJson:\n' + safeJson + '\n');

const assertions = [
  ['no `<` character (covers </script>, <!-- )', !safeJson.includes('<')],
  ['no `>` character (covers ]]> close)',        !safeJson.includes('>')],
  ['no `&` character (entity defenses)',          !safeJson.includes('&')],
];

const parsed = JSON.parse(safeJson);
assertions.push(['parses back to identical username', parsed.username === malicious.username]);
assertions.push(['parses back to identical nested',   parsed.items[2].name === malicious.items[2].name]);

let allOK = true;
for (const [name, ok] of assertions) {
  console.log(ok ? '✓' : '✗', name);
  if (!ok) allOK = false;
}
process.exit(allOK ? 0 : 1);
