// Convert cli/ayanokoji.png → colored ANSI art (half-block, truecolor).
// Emits a FULL version (splash/menu) and a COMPACT version (live run header),
// writes art.txt / art-sm.txt, and prints the base64 of each for embedding
// into checker.js (ART_LINES / ART_SM).
//   node asciiart.js [fullWidth] [compactWidth]
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const SRC = path.join(__dirname, 'ayanokoji.png');
const FULL_W = Math.max(20, Math.min(80, parseInt(process.argv[2], 10) || 46));
const SM_W   = Math.max(16, Math.min(40, parseInt(process.argv[3], 10) || 26));

if (!fs.existsSync(SRC)) { console.log('! Save the image as cli/ayanokoji.png first.'); process.exit(1); }

async function render(W) {
  const img = await Jimp.read(SRC);
  img.resize(W, Jimp.AUTO);
  const h = img.bitmap.height - (img.bitmap.height % 2);
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    let line = '';
    for (let x = 0; x < W; x++) {
      const t = Jimp.intToRGBA(img.getPixelColor(x, y));
      const b = Jimp.intToRGBA(img.getPixelColor(x, y + 1));
      line += `\x1b[38;2;${t.r};${t.g};${t.b}m\x1b[48;2;${b.r};${b.g};${b.b}m▀`;
    }
    rows.push(line + '\x1b[0m');
  }
  return rows;
}

(async () => {
  const full = await render(FULL_W);
  const sm   = await render(SM_W);
  fs.writeFileSync(path.join(__dirname, 'art.txt'), full.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'art-sm.txt'), sm.join('\n'));
  const b64 = (rows) => Buffer.from(rows.join('\n'), 'utf8').toString('base64');
  console.log(`✓ art.txt    ${full.length} rows × ${FULL_W} cols`);
  console.log(`✓ art-sm.txt ${sm.length} rows × ${SM_W} cols`);
  console.log('\n--- FULL_B64 ---\n' + b64(full));
  console.log('\n--- SM_B64 ---\n' + b64(sm));
})().catch((e) => { console.log('! convert failed:', e.message); process.exit(1); });
