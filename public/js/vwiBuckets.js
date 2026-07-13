// VWI sorter classification — single source of truth shared by the browser
// (admin.html sorter) and node test scripts. Pure: no DOM, no I/O.
//
// UMD: require() in node, or window.VwiBuckets in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VwiBuckets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function extractField(line, label) {
    const re = new RegExp('\\|\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*([^|]*)', 'i');
    const m = line.match(re);
    return m ? m[1].trim() : '';
  }
  function getItemsList(line) {
    const raw = extractField(line, 'Skins');
    if (!raw || raw === '—' || raw === '-') return [];
    return raw.split(',').map(s => s.replace(/^\s*\d+\s*[×x]\s*/, '').trim()).filter(Boolean);
  }
  function getRanksList(line) {
    const raw = extractField(line, 'Ranks');
    if (!raw || raw === '—') return [];
    return raw.split(',').map(r => r.trim().split(' (')[0].trim()).filter(Boolean);
  }
  function getLevel(line) { return parseInt(extractField(line, 'Lvl'), 10); }
  function isLinkable(line) { return /XBX|PSN|XBOX|PLAYSTATION/i.test(extractField(line, 'Linkable')); }
  function isBanned(line) { return /^(y|yes|true|banned|1)$/i.test(extractField(line, 'Banned')); }
  function isValidLine(line) { return line.includes('| User: ') && line.includes('| Lvl: '); }
  function canLinkPsn(line) { return /PSN|PLAYSTATION/i.test(extractField(line, 'Linkable')); }
  function canLinkXbx(line) { return /XBX|XBOX/i.test(extractField(line, 'Linkable')); }
  // Phone verified on the Ubi account — required for VWI (operator spec: clean
  // resale accounts must have a verified phone; "?" = fetch failed, doesn't qualify).
  function isPhoneVerified(line) { return /^y$/i.test(extractField(line, 'PhoneVerified')); }

  // Classify every line into exactly one bucket. Priority:
  //   banned-with-qualifier > rank > named item > mystery item > leftover.
  // Banned accounts ignore the linkable requirement (sold for cosmetics).
  function bucketAccounts(linesArr, meta) {
    const ranksOrder = meta.ranks || [];
    const named = meta.namedItemBuckets || [];
    const bannedVwi = meta.bannedVwi || { ranks: [], items: [] };

    const rankBuckets = {};
    ranksOrder.forEach(r => rankBuckets[r] = { count: 0, lines: [] });
    const itemBuckets = {};
    named.forEach(i => itemBuckets[i] = { count: 0, lines: [] });
    itemBuckets['Mystery Items'] = { count: 0, lines: [] };
    const bannedBucket = { count: 0, lines: [] };
    const leftovers = {
      'No VWI — Lvl 50 & below': { count: 0, lines: [] },
      'No VWI — Lvl above 50': { count: 0, lines: [] },
    };

    let vwiTotal = 0, valid = 0, excluded = 0, noLvlCount = 0, duplicates = 0;
    const seen = new Set();

    for (let raw of linesArr) {
      const line = (raw || '').replace(/\r$/, '');
      if (!line || !isValidLine(line)) continue;
      const email = line.split('|')[0].split(':')[0].trim().toLowerCase();
      if (email) { if (seen.has(email)) { duplicates++; continue; } seen.add(email); }
      valid++;

      const ranks = getRanksList(line);
      const items = getItemsList(line);

      if (isBanned(line)) {
        const q = bannedVwi.ranks.some(r => ranks.includes(r)) || bannedVwi.items.some(i => items.includes(i));
        if (q) { vwiTotal++; bannedBucket.count++; bannedBucket.lines.push(line); }
        else excluded++;
        continue;
      }
      if (!isLinkable(line)) { excluded++; continue; }
      // Phone-verified gate. Without a verified phone, a clean resale account is
      // recovery-vulnerable — operator spec is "no phone → not VWI". Falls through
      // to the level-based leftover bucket so the account still shows up in the
      // right size class; it just isn't sold as VWI.
      const phoneOk = isPhoneVerified(line);

      const highestRank = ranksOrder.find(r => ranks.includes(r));
      if (highestRank && phoneOk) { vwiTotal++; rankBuckets[highestRank].count++; rankBuckets[highestRank].lines.push(line); continue; }

      const topNamed = named.find(i => items.includes(i));
      if (topNamed && phoneOk) { vwiTotal++; itemBuckets[topNamed].count++; itemBuckets[topNamed].lines.push(line); continue; }

      if (items.length && phoneOk) { vwiTotal++; itemBuckets['Mystery Items'].count++; itemBuckets['Mystery Items'].lines.push(line); continue; }

      const lvl = getLevel(line);
      if (isNaN(lvl)) { noLvlCount++; continue; }
      const key = lvl <= 50 ? 'No VWI — Lvl 50 & below' : 'No VWI — Lvl above 50';
      leftovers[key].count++; leftovers[key].lines.push(line);
    }

    return {
      rankBuckets, itemBuckets, bannedBucket, leftovers,
      stats: { vwiTotal, valid, excluded, noLvlCount, duplicates },
    };
  }

  return {
    bucketAccounts,
    extractField, getItemsList, getRanksList, getLevel,
    isLinkable, isBanned, isPhoneVerified, isValidLine, canLinkPsn, canLinkXbx,
  };
});
