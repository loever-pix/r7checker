// Store sync — route checked accounts into the right SellAuth product by their
// tier + platform, and auto-generate each variant's description from the account
// format.
//
// The shop's products are already named by tier × platform, e.g.:
//   [PSN] Champion NFA · [XBX] Diamond NFA · [XBX/PSN] Emerald NFA ·
//   [PSN] Platinum NFA · [XBX] Mystery Wanted Items NFA  (= VWI)
//
// classifyAccount(line) reads the result-line fields (Ranks / Skins / Linkable)
// to decide a {tier, platform}; we then match that to the product whose name
// encodes the same tier+platform, append the account to its stock, and rewrite
// the variant description from the aggregate of what's in that bucket.

const sa = require('./sellauth');

// ── Result-line parsing ──────────────────────────────────────────────────────
// Lines look like: "email:pass | User: X | Lvl: 59 | Items: 21 | Ranks: Diamond
// (S38) | Skins: 3× Glacier | Linkable: XBX | Banned: N | EmailVerified: Y | …"
function parseLine(line) {
  const out = { raw: line, creds: '', fields: {} };
  const parts = String(line).split('|').map(s => s.trim());
  out.creds = parts[0] || '';
  for (const seg of parts.slice(1)) {
    const ci = seg.indexOf(':');
    if (ci < 0) continue;
    out.fields[seg.slice(0, ci).trim().toLowerCase()] = seg.slice(ci + 1).trim();
  }
  return out;
}

// Rank tier ranking — higher index = better. Used to pick the peak tier.
const RANK_TIERS = ['copper', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'champion'];
// The bulk format abbreviates ranks ("Plat (S30)", "Champ"), so match aliases —
// otherwise a "Plat" account with a wanted skin gets misfiled as Mystery/VWI.
const RANK_ALIASES = {
  copper: ['copper'], bronze: ['bronze'], silver: ['silver'], gold: ['gold'],
  platinum: ['platinum', 'plat'], emerald: ['emerald', 'emer'],
  diamond: ['diamond', 'diam'], champion: ['champion', 'champ'],
};
function rankTierFromRanksField(ranksVal) {
  if (!ranksVal || ranksVal === '—') return null;
  const v = ranksVal.toLowerCase();
  let best = -1;
  for (let i = 0; i < RANK_TIERS.length; i++) {
    if ((RANK_ALIASES[RANK_TIERS[i]] || [RANK_TIERS[i]]).some(a => v.includes(a))) best = Math.max(best, i);
  }
  return best >= 0 ? RANK_TIERS[best] : null;
}

// Platform from the Linkable field ("PSN", "XBX", "PSN, XBX", "—").
function platformFromLinkable(linkVal) {
  const v = String(linkVal || '').toUpperCase();
  const psn = /PSN|PS\b|PLAYSTATION/.test(v);
  const xbx = /XBX|XBL|XBOX/.test(v);
  if (psn && xbx) return 'both';
  if (psn) return 'psn';
  if (xbx) return 'xbx';
  return null;   // PC-only / unlinked — no console product for it
}

const PRODUCT_TIERS = ['champion', 'diamond', 'emerald', 'platinum']; // tiers that have rank products
const PLATINUM_IDX = RANK_TIERS.indexOf('platinum');

// Decide {tier, platform} for an account. Tier: a rank Platinum+ maps to that
// rank product; otherwise, if the account carries wanted skins, it's "vwi"
// (Mystery Wanted Items); otherwise null (no matching product → reported).
function classifyAccount(line) {
  const p = parseLine(line);
  const platform = platformFromLinkable(p.fields.linkable);
  const rankTier = rankTierFromRanksField(p.fields.ranks);
  const skins = p.fields.skins;
  const hasWanted = skins && skins !== '—' && skins.trim() !== '';

  // Rank Platinum+ → that rank product (rank is the headline value). Otherwise,
  // if the account carries wanted skins → VWI (Mystery Wanted Items) catch
  // bucket. Below Platinum with no wanted skins → null (no matching product).
  let tier = null;
  if (rankTier && RANK_TIERS.indexOf(rankTier) >= PLATINUM_IDX && PRODUCT_TIERS.includes(rankTier)) {
    tier = rankTier;
  } else if (hasWanted) {
    tier = 'vwi';
  }
  return { tier, platform, parsed: p };
}

// ── Product name → {tier, platform} ──────────────────────────────────────────
function classifyProduct(name) {
  const n = String(name || '').toLowerCase();
  let platform = null;
  const hasPsn = /\bpsn\b/.test(n), hasXbx = /\bxbx\b|\bxbl\b|\bxbox\b/.test(n);
  if (hasPsn && hasXbx) platform = 'both';
  else if (hasPsn) platform = 'psn';
  else if (hasXbx) platform = 'xbx';
  let tier = null;
  if (/mystery|wanted/.test(n)) tier = 'vwi';
  else for (const t of PRODUCT_TIERS) if (n.includes(t)) { tier = t; break; }
  return { tier, platform };
}

// A console account linked to BOTH shows up in a [XBX/PSN] product; an account
// linked to only one platform matches that platform's product OR the combined
// one. We match exact first, then fall back to the combined product.
function productMatches(prodClass, acctClass) {
  if (prodClass.tier !== acctClass.tier) return 0;
  if (prodClass.platform === acctClass.platform) return 2;       // exact
  if (prodClass.platform === 'both') return 1;                    // combined catch-all
  return 0;
}

// ── Aggregate stats + description ────────────────────────────────────────────
function aggregate(parsedList) {
  const nums = (key) => parsedList.map(p => Number(String(p.fields[key] || '').replace(/[^0-9.]/g, ''))).filter(n => n > 0);
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const levels = nums('lvl'); const items = nums('items');
  const banFree = parsedList.filter(p => /^n/i.test(p.fields.banned || 'N')).length;
  const emailV  = parsedList.filter(p => /^y/i.test(p.fields.emailverified || '')).length;
  const phoneV  = parsedList.filter(p => /^y/i.test(p.fields.phoneverified || '')).length;
  return {
    count: parsedList.length,
    avgLevel: avg(levels), maxLevel: Math.max(0, ...levels),
    avgItems: avg(items),  maxItems: Math.max(0, ...items),
    banFreePct: parsedList.length ? Math.round(banFree / parsedList.length * 100) : 0,
    emailVPct: parsedList.length ? Math.round(emailV / parsedList.length * 100) : 0,
    phoneVPct: parsedList.length ? Math.round(phoneV / parsedList.length * 100) : 0,
  };
}

const TIER_LABEL = { champion: 'Champion', diamond: 'Diamond', emerald: 'Emerald', platinum: 'Platinum', vwi: 'Mystery Wanted Items' };
const PLATFORM_LABEL = { psn: 'PlayStation', xbx: 'Xbox', both: 'Xbox & PlayStation' };

// Build a clean store description. When the bucket is ONE account (a per-account
// variant) it reads as a single concrete account; for a pool it summarises the
// aggregate ("on average", "up to").
function buildDescription(tier, platform, stats) {
  const tierName = TIER_LABEL[tier] || tier;
  const plat = PLATFORM_LABEL[platform] || '';
  const single = stats.count === 1;
  const article = /^[aeiou]/i.test(tierName) ? 'an' : 'a';
  const lines = [];
  if (tier === 'vwi') {
    lines.push(`**Mystery Wanted-Items account** — hand-picked for rare & sought-after cosmetics (Black Ice, Glacier, Elite skins & more).`);
  } else {
    lines.push(`**${tierName} · ${plat}** — peak rank ${tierName} on ${article} ${plat} account.`);
  }
  const bullets = [];
  if (single) {
    if (stats.maxItems) bullets.push(`${stats.maxItems} cosmetic items`);
    if (stats.maxLevel) bullets.push(`Level ${stats.maxLevel}`);
    bullets.push('Full ranked season history & ranked charms');
    if (stats.banFreePct >= 100) bullets.push('Ban-checked clean ✓');
    if (stats.emailVPct >= 100)  bullets.push('Email verified ✓');
    if (stats.phoneVPct >= 100)  bullets.push('Phone verified ✓');
  } else {
    if (stats.avgItems) bullets.push(`~${stats.avgItems} cosmetic items on average${stats.maxItems > stats.avgItems ? ` (up to ${stats.maxItems})` : ''}`);
    if (stats.avgLevel) bullets.push(`average level ${stats.avgLevel}`);
    bullets.push('full ranked season history & ranked charms');
    if (stats.banFreePct >= 100) bullets.push('**ban-checked clean** ✓');
    else if (stats.banFreePct)   bullets.push(`${stats.banFreePct}% ban-free`);
    if (stats.emailVPct) bullets.push(`${stats.emailVPct === 100 ? 'email verified' : stats.emailVPct + '% email-verified'}`);
  }
  if (bullets.length) lines.push(bullets.map(b => `• ${b}`).join('\n'));
  lines.push(`Delivered as email:password (NFA — non-full access). ${plat} linked.`);
  // SellAuth renders raw text — strip markdown so "**bold**" / `code` don't leak.
  return lines.join('\n\n').replace(/\*\*/g, '').replace(/`/g, '');
}

// ── Sync ─────────────────────────────────────────────────────────────────────
// Classify each account line, route to the matching product, append to stock,
// and rewrite that variant's description from the bucket aggregate.
// Returns a per-bucket report. opts.dryRun classifies without writing.
async function syncAccounts(lines, opts = {}) {
  const products = await sa.listProducts();
  const prodClasses = products.map(p => ({ p, cls: classifyProduct(p.name) }));

  // Bucket accounts → product.
  const buckets = new Map();        // productId → { product, lines:[], parsed:[] }
  const unmatched = [];
  for (const raw of lines) {
    const { tier, platform, parsed } = classifyAccount(raw);
    if (!tier || !platform) { unmatched.push({ raw, reason: `tier=${tier || '?'} platform=${platform || '?'}` }); continue; }
    // Best matching product (exact platform beats combined).
    let best = null, bestScore = 0;
    for (const pc of prodClasses) {
      const s = productMatches(pc.cls, { tier, platform });
      if (s > bestScore) { best = pc.p; bestScore = s; }
    }
    if (!best) { unmatched.push({ raw, reason: `no product for ${tier}/${platform}` }); continue; }
    let b = buckets.get(best.id);
    if (!b) { b = { product: best, lines: [], parsed: [] }; buckets.set(best.id, b); }
    b.lines.push(raw);
    b.parsed.push(parsed);
  }

  const report = { routed: [], unmatched, dryRun: !!opts.dryRun };
  for (const b of buckets.values()) {
    const cls = classifyProduct(b.product.name);
    const entry = { product: b.product.name, productId: b.product.id, tier: cls.tier, platform: cls.platform, added: b.lines.length };
    if (!opts.dryRun) {
      try {
        // 1) append the account lines to the product's variant stock
        const updated = await sa.appendStock(b.product.id, b.product.variantId, b.lines);
        entry.newStock = Array.isArray(updated) ? updated.length : null;
        // 2) rewrite the variant description from the aggregate of WHAT WE JUST
        //    added (representative of the bucket). Uses the full-replace update
        //    that already preserves every other field + images.
        const desc = buildDescription(cls.tier, cls.platform, aggregate(b.parsed));
        await setVariantDescription(b.product.id, desc);
        entry.description = desc;
      } catch (e) { entry.error = e.message; }
    } else {
      entry.description = buildDescription(cls.tier, cls.platform, aggregate(b.parsed));
    }
    report.routed.push(entry);
  }
  return report;
}

// Set the FIRST variant's description via the full-replace product update
// (reuses sellauth's safe echo so images/config aren't wiped).
async function setVariantDescription(productId, description) {
  const sellauth = require('./sellauth');
  // We can't call the un-exported buildProductUpdate, so fetch + update through
  // a tiny inline echo mirroring updatePrice's preservation.
  const cfg = require('./config').cfg;
  const r = await fetch(`${cfg.sellauth.base}/v1/shops/${cfg.sellauth.shopId}/products/${productId}`,
    { headers: { Authorization: `Bearer ${cfg.sellauth.key}`, Accept: 'application/json' } });
  const data = await r.json();
  const p = data.product || data;
  const variants = (p.variants || []).map((v, i) => {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (['stock', 'product_id', 'order', 'files', 'created_at', 'updated_at'].includes(k)) continue;
      if (val !== null && val !== undefined) out[k] = val;
    }
    if (i === 0) out.description = description;         // only the first variant
    out.price = String(v.price);
    out.volume_discounts = v.volume_discounts || [];
    out.discord_roles = v.discord_roles || [];
    return out;
  });
  // Echo the product fields (same preservation list updatePrice uses).
  const payload = {};
  for (const [k, val] of Object.entries(p)) {
    if (['id', 'shop_id', 'variants', 'images', 'stock_count', 'created_at', 'updated_at', 'custom_fields', 'sales_count', 'views_count'].includes(k)) continue;
    if (val !== null && val !== undefined) payload[k] = val;
  }
  payload.image_ids = (p.images || []).map(i => i.id);
  payload.variants = variants;
  const up = await fetch(`${cfg.sellauth.base}/v1/shops/${cfg.sellauth.shopId}/products/${productId}/update`,
    { method: 'PUT', headers: { Authorization: `Bearer ${cfg.sellauth.key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!up.ok) { const t = await up.text().catch(() => ''); throw new Error(`description update HTTP ${up.status} ${t.slice(0, 120)}`); }
  return true;
}

// Regenerate the description of EVERY product from the accounts already in its
// stock — so the owner never has to re-upload/format anything. For each product
// we read its current deliverables, aggregate the format, and rewrite the
// variant description. Returns a per-product report. opts.dryRun skips writes.
async function syncAllStock(opts = {}) {
  const products = await sa.listProducts();
  const report = { updated: [], skipped: [], dryRun: !!opts.dryRun };
  for (const prod of products) {
    const cls = classifyProduct(prod.name);
    if (!cls.tier) { report.skipped.push({ product: prod.name, reason: 'unknown tier' }); continue; }
    if (!prod.variantId) { report.skipped.push({ product: prod.name, reason: 'no variant' }); continue; }
    let serials = [];
    try { serials = await sa.getDeliverables(prod.id, prod.variantId); } catch (e) {
      report.skipped.push({ product: prod.name, reason: 'deliverables read failed: ' + e.message }); continue;
    }
    if (!serials.length) { report.skipped.push({ product: prod.name, reason: 'no stock' }); continue; }
    const parsed = serials.map(s => parseLine(s));
    const desc = buildDescription(cls.tier, cls.platform, aggregate(parsed));
    const entry = { product: prod.name, productId: prod.id, stock: serials.length };
    if (!opts.dryRun) {
      try { await setVariantDescription(prod.id, desc); entry.description = desc; }
      catch (e) { entry.error = e.message; }
    } else { entry.description = desc; }
    report.updated.push(entry);
  }
  return report;
}

// ── Per-account variants (/syncvariants) ─────────────────────────────────────
// Turn a stocked rank product (ONE variant, N accounts in its deliverables)
// into N buyable variants — one per account, each with that account's own
// description + the same price — so buyers can pick the exact account. Works
// for a SINGLE stocked account too (1 account → the existing variant just gets
// that account's description). Mystery/Wanted products stay pooled.
// Per-account variant name + description mirror the IMPORTED result-line fields
// (pipe-delimited, plain text — SellAuth shows raw text, markdown leaks as "**").
const _digits = (v) => String(v || '').replace(/[^0-9]/g, '');
const _yn = (v, yes = 'Yes', no = 'No') => /^y/i.test(String(v || '')) ? yes : (/^n/i.test(String(v || '')) ? no : '?');
const RANK_FULL = { plat: 'Platinum', platinum: 'Platinum', champ: 'Champion', champion: 'Champion', diam: 'Diamond', diamond: 'Diamond', emer: 'Emerald', emerald: 'Emerald', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', copper: 'Copper' };

function _platformTag(linkable) {
  const v = String(linkable || '').toUpperCase();
  const out = [];
  if (/PSN|PLAYSTATION/.test(v)) out.push('PSN');
  if (/XBX|XBL|XBOX/.test(v)) out.push('XBL');
  return out.length ? `${out.join(' & ')} Linkable` : null;
}
function _platformShort(linkable) {
  const v = String(linkable || '').toUpperCase();
  const psn = /PSN|PLAYSTATION/.test(v), xbx = /XBX|XBL|XBOX/.test(v);
  if (psn && xbx) return 'XBOX/PSN';
  if (xbx) return 'XBOX';
  if (psn) return 'PSN';
  return null;
}
function _lastPlayedRel(lp) {
  if (!lp || lp === '—') return null;
  const m = String(lp).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(lp).trim() || null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  return days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
}
// "Plat (S30), Plat (S37)" -> "2x Platinum"; "Plat, Diamond" -> "Platinum, Diamond"
function _ranksSummary(ranks) {
  if (!ranks || ranks === '—') return null;
  const counts = {}, order = [];
  for (const seg of String(ranks).split(',')) {
    const word = (seg.trim().match(/[a-z]+/i) || [''])[0].toLowerCase();
    const full = RANK_FULL[word]; if (!full) continue;
    if (!(full in counts)) { counts[full] = 0; order.push(full); }
    counts[full]++;
  }
  return order.length ? order.map(t => counts[t] > 1 ? `${counts[t]}x ${t}` : t).join(', ') : null;
}
// "Plat (S30)" -> "Platinum (S30)" (keeps seasons, for the description)
function _ranksExpand(ranks) {
  if (!ranks || ranks === '—') return null;
  return String(ranks).replace(/\b(platinum|plat|champion|champ|diamond|diam|emerald|emer|gold|silver|bronze|copper)\b/gi,
    (w) => RANK_FULL[w.toLowerCase()] || w);
}
// "1x Silver GO4 Charm, 2x Racer" -> "Silver GO4 Charm, Racer"
function _skinsClean(skins) {
  if (!skins || skins === '—') return null;
  const out = String(skins).split(',').map(s => s.trim().replace(/^\d+x\s*/i, '')).filter(Boolean).join(', ');
  return out || null;
}

// Variant NAME — leads with the high-value attributes, ≤100 chars. e.g.
//   "Silver GO4 Charm | 2x Platinum | Lvl 265 | 822 Items | XBOX"
function accountVariantName(parsed) {
  const f = parsed.fields || {};
  const bits = [];
  const skins = _skinsClean(f.skins);
  if (skins) bits.push(skins.split(',')[0].trim());           // headline wanted item
  const ranks = _ranksSummary(f.ranks);
  if (ranks) bits.push(ranks);
  if (f.lvl) bits.push(`Lvl ${_digits(f.lvl)}`);
  if (f.items) bits.push(`${f.items} Items`);
  const ps = _platformShort(f.linkable);
  if (ps) bits.push(ps);
  let name = bits.join(' | ');
  if (!name) name = (f.user || (parsed.creds.split(':')[0] || '').split('@')[0] || 'Account').trim();
  return name.slice(0, 100);
}

// Variant DESCRIPTION — the imported account's fields, relabeled & pipe-joined.
function accountVariantDescription(parsed) {
  const f = parsed.fields || {};
  const p = [];
  const user = (f.user || (parsed.creds.split(':')[0] || '').split('@')[0] || '').trim();
  if (user) p.push(`Username: ${user}`);
  if (f.lvl) p.push(`Level: ${_digits(f.lvl)}`);
  if (f.items) p.push(`Items: ${f.items}`);
  if (f['2fa'] != null || f.phoneverified != null) p.push(`2FA/Phone: ${_yn(f['2fa'])}/${_yn(f.phoneverified)}`);
  p.push(`Banned: ${_yn(f.banned)}`);
  if (f.renown) p.push(`Renown: ${f.renown}`);
  if (f.credits) p.push(`Credits: ${f.credits}`);
  const plat = _platformTag(f.linkable);
  if (plat) p.push(`Platforms: [${plat}]`);
  const lp = _lastPlayedRel(f.lastplayed);
  if (lp) p.push(`Last Played: ${lp}`);
  const ranks = _ranksExpand(f.ranks);
  if (ranks) p.push(`Wanted Ranks: ${ranks}`);
  const skins = _skinsClean(f.skins);
  if (skins) p.push(`Wanted Items: [${skins}]`);
  return p.join(' | ');
}

// Ensure a variant name is unique within a run (SellAuth lets dup names exist,
// but we map name -> id afterwards, so collisions must be disambiguated).
function _uniqueName(name, used) {
  let n = name, k = 2;
  while (used.has(n)) n = `${name} #${k++}`.slice(0, 100);
  used.add(n);
  return n;
}

// Append new accounts to a product as per-account variants — ONE buyable
// variant per account — without touching any existing variant or its stock.
// Safe to run on an already-split product (that's the whole point: "unlimited
// variants"). Mystery/Wanted products stay pooled (append to the one variant).
// Returns { product, added, written, variants[], pooled?, newStock?, error? }.
// opts.dryRun → compute the plan, write nothing.
async function addAccountVariants(productId, newLines, opts = {}) {
  const dryRun = !!opts.dryRun;
  const p = await sa.getProductRaw(productId);
  if (!p) return { product: `#${productId}`, error: 'product not found', added: 0, variants: [] };
  const cls = classifyProduct(p.name);
  const existing = p.variants || [];
  const base = existing[0];
  if (!base) return { product: p.name, error: 'product has no variant to template from', added: 0, variants: [] };

  const lines = (newLines || []).map(l => String(l).trim()).filter(Boolean);
  if (!lines.length) return { product: p.name, added: 0, variants: [] };

  // Pooled products (Mystery / Wanted Items): append to the single variant and
  // refresh its aggregate description — they're intentionally not per-account.
  if (/mystery|wanted/i.test(p.name) || cls.tier === 'vwi') {
    if (dryRun) return { product: p.name, pooled: true, added: lines.length, variants: [] };
    // Idempotency: skip serials already in stock so a re-run after a timeout
    // never double-adds the same accounts to the pooled variant.
    let toAdd = lines;
    try {
      const have = new Set(await sa.getDeliverables(productId, base.id));
      toAdd = lines.filter(l => !have.has(l));
    } catch { /* if we can't read stock, fall back to adding all */ }
    const updated = toAdd.length
      ? await sa.appendStock(productId, base.id, toAdd)
      : await sa.getDeliverables(productId, base.id);
    const newStock = Array.isArray(updated) ? updated.length : null;
    try {
      const all = await sa.getDeliverables(productId, base.id);
      await setVariantDescription(productId, buildDescription(cls.tier, cls.platform, aggregate(all.map(parseLine))));
    } catch { /* description refresh is best-effort */ }
    // Pooled price: set the single variant's price (e.g. Mystery flat) if asked.
    if (opts.poolPrice != null) {
      try { await sa.updatePrice(productId, opts.poolPrice); } catch { /* price set is best-effort */ }
    }
    return { product: p.name, pooled: true, added: toAdd.length, newStock, variants: [] };
  }

  // Rank products: one NEW id-less variant per new account. Global index offset
  // by the existing variant count keeps the auto-names unique across restocks.
  const basePrice = String(base.price);
  // Seed the uniqueness set with existing variant names so a new variant never
  // collides with one we're keeping.
  const usedNames = new Set((existing || []).map(v => v.name).filter(Boolean));

  // Idempotency: when asked, skip accounts already stocked as a variant so a
  // re-run after a timeout never double-adds the same account.
  let toAdd = lines;
  if (opts.dedup && !dryRun) {
    try {
      const have = new Set();
      for (const v of existing) for (const s of await sa.getDeliverables(productId, v.id)) have.add(s);
      toAdd = lines.filter(l => !have.has(l));
    } catch { /* if stock can't be read, fall back to adding all */ }
  }

  // Per-account price comes from opts.priceFor(line) when provided (the VWI
  // pricing engine); otherwise every variant inherits the product's base price.
  const plan = toAdd.map((line) => {
    const parsed = parseLine(line);
    return {
      serial: line,
      name: _uniqueName(accountVariantName(parsed), usedNames),
      description: accountVariantDescription(parsed),
      price: opts.priceFor ? String(opts.priceFor(line)) : basePrice,
    };
  });
  const result = { product: p.name, productId, added: plan.length, written: 0,
    variants: plan.map(v => ({ name: v.name, price: v.price })), dryRun };
  if (dryRun) return result;

  // Product-level description: a single resulting account has no variant picker
  // on the storefront, so surface its details on the product; multiple → guide.
  if (existing.length + plan.length === 1) {
    p.description = plan[0].description;
  } else {
    p.description = `Pick an account below — each variant is a different inactive ${TIER_LABEL[cls.tier] || cls.tier} · ${PLATFORM_LABEL[cls.platform] || ''} account. Choosing an inactive one gives you the best odds. Delivered as email:password (NFA — non-full access).`;
  }

  // Echo existing variants (ids preserved → their stock stays linked) and append
  // the new id-less ones (SellAuth creates them). Then map new names → ids and
  // stock each new variant with its one account. Existing stock is never touched.
  //
  // opts.replaceExisting (used for a freshly CLONED product) drops the inherited
  // placeholder variant entirely so the new product holds ONLY account variants.
  const newVariants = plan.map(v => { const o = { ...base, name: v.name, description: v.description, price: v.price }; delete o.id; return o; });
  const existingIds = opts.replaceExisting ? new Set() : new Set(existing.map(v => v.id));
  const rawVariants = opts.replaceExisting ? newVariants : [...existing, ...newVariants];
  await sa.updateProduct(productId, sa.buildProductUpdate(p, rawVariants));

  const after = await sa.getProductRaw(productId);
  const byName = new Map((after.variants || []).map(v => [v.name, v.id]));
  for (const v of plan) {
    const vid = byName.get(v.name);
    if (!vid || existingIds.has(vid)) continue;   // never overwrite an existing variant's stock
    try { await sa.overwriteStock(productId, vid, [v.serial]); result.written++; } catch { /* re-run fixes */ }
  }
  return result;
}

// Split ONE product. Returns { product, sourceStock, written, variants[], skipped?, reason? }.
// opts.dryRun → compute the plan, write nothing (SAFE preview).
async function splitProductAccountVariants(productId, opts = {}) {
  const dryRun = !!opts.dryRun;
  const p = await sa.getProductRaw(productId);
  if (!p) return { product: `#${productId}`, skipped: true, reason: 'product not found', variants: [] };
  const cls = classifyProduct(p.name);
  if (/mystery|wanted/i.test(p.name) || cls.tier === 'vwi') {
    return { product: p.name, skipped: true, reason: 'mystery/wanted stays pooled', variants: [] };
  }
  const existing = p.variants || [];
  if (!existing.length) return { product: p.name, skipped: true, reason: 'no variant', variants: [] };

  // Read EVERY variant's stock and dedup across the whole product (a serial that
  // somehow appears in two variants is kept only once). This is what makes the
  // sync work for ALL products — pooled, partially split, or fully split.
  const seen = new Set();
  const slots = [];   // { variant, accounts:[unique...], hadStock }
  for (const v of existing) {
    let s = [];
    try { s = await sa.getDeliverables(productId, v.id); }
    catch (e) { return { product: p.name, skipped: true, reason: 'deliverables read failed: ' + e.message, variants: [] }; }
    const acc = [];
    for (const line of s) { const t = String(line).trim(); if (t && !seen.has(t)) { seen.add(t); acc.push(t); } }
    slots.push({ variant: v, accounts: acc, hadStock: s.length > 0 });
  }
  const totalAccounts = slots.reduce((n, sl) => n + sl.accounts.length, 0);
  if (!totalAccounts) return { product: p.name, skipped: true, reason: 'no stock', variants: [] };

  // Each existing variant KEEPS its first account; the rest overflow into new
  // variants. Names are the account summary, de-duplicated within the run.
  const basePrice = String(existing[0].price);
  const usedNames = new Set();
  const metaFor = (line) => {
    const parsed = parseLine(line);
    return {
      name: _uniqueName(accountVariantName(parsed), usedNames),
      description: accountVariantDescription(parsed),
    };
  };

  const previewVariants = [];
  const keepers = slots.map(sl => {
    if (!sl.accounts.length) return { variant: sl.variant, account: null, hadStock: sl.hadStock };
    const m = metaFor(sl.accounts[0]);
    previewVariants.push({ name: m.name, price: basePrice });
    return { variant: sl.variant, account: sl.accounts[0], meta: m, hadStock: sl.hadStock };
  });
  const overflow = [];
  for (const sl of slots) for (let i = 1; i < sl.accounts.length; i++) {
    const m = metaFor(sl.accounts[i]);
    previewVariants.push({ name: m.name, price: basePrice });
    overflow.push({ account: sl.accounts[i], meta: m });
  }

  const result = { product: p.name, productId, sourceStock: totalAccounts, written: 0, variants: previewVariants, dryRun };
  if (dryRun) return result;

  // Product-level description. A SINGLE account has no variant picker on the
  // storefront (SellAuth hides it), so surface that account's details on the
  // product itself; with multiple accounts, guide the buyer to the picker.
  if (totalAccounts === 1) {
    const only = keepers.find(k => k.account);
    if (only && only.meta) p.description = only.meta.description;
  } else {
    p.description = `Pick an account below — each variant is a different inactive ${TIER_LABEL[cls.tier] || cls.tier} · ${PLATFORM_LABEL[cls.platform] || ''} account. Choosing an inactive one gives you the best odds. Delivered as email:password (NFA — non-full access).`;
  }

  // 1) ONE update: rename each existing variant to its kept account + append a
  //    new id-less variant per overflow account. Deliverables stay linked to the
  //    existing ids (variantPayload omits stock), so nothing is dropped here.
  const rawVariants = [
    ...keepers.map(k => k.account
      ? { ...k.variant, name: k.meta.name, description: k.meta.description, price: basePrice }
      : { ...k.variant }),
    ...overflow.map(o => { const ov = { ...existing[0], name: o.meta.name, description: o.meta.description, price: basePrice }; delete ov.id; return ov; }),
  ];
  await sa.updateProduct(productId, sa.buildProductUpdate(p, rawVariants));

  // 2) Map names → ids (overflow variants now have ids).
  const after = await sa.getProductRaw(productId);
  const byName = new Map((after.variants || []).map(v => [v.name, v.id]));

  // 3) Stock NEW overflow variants FIRST, then trim each kept variant to its one
  //    account LAST. A mid-way failure can only DUPLICATE (re-runnable), never
  //    lose: the source pool stays intact on the kept id until the very end.
  for (const o of overflow) {
    const vid = byName.get(o.meta.name);
    if (!vid) continue;
    try { await sa.overwriteStock(productId, vid, [o.account]); result.written++; } catch { /* re-run fixes */ }
  }
  for (const k of keepers) {
    try {
      if (k.account) { await sa.overwriteStock(productId, k.variant.id, [k.account]); result.written++; }
      else if (k.hadStock) { await sa.overwriteStock(productId, k.variant.id, []); }  // all-duplicate → clear
    } catch { /* re-run fixes */ }
  }
  return result;
}

// Split EVERY rank product (Mystery/Wanted skipped). opts.dryRun previews.
async function splitAllAccountVariants(opts = {}) {
  const products = await sa.listProducts();
  const report = { updated: [], skipped: [], dryRun: !!opts.dryRun };
  for (const prod of products) {
    if (/mystery|wanted/i.test(prod.name)) { report.skipped.push({ product: prod.name, reason: 'mystery/wanted' }); continue; }
    let r;
    try { r = await splitProductAccountVariants(prod.id, opts); }
    catch (e) { report.skipped.push({ product: prod.name, reason: e.message }); continue; }
    if (r.skipped) report.skipped.push({ product: r.product, reason: r.reason });
    else report.updated.push(r);
  }
  return report;
}

// Remove ONE account from a product (used by the re-sort to pull a mis-placed
// account out of its current product after it's been added to the correct one).
//   opts.variantId  → per-account-variant product: drop that whole variant.
//   opts.pooled     → pooled (Mystery) product: drop the matching serial.
//   opts.email      → the account email (lowercased) used to match the serial.
// Returns { removed:0|1, error? }.
async function removeAccountFromProduct(productId, opts = {}) {
  const email = String(opts.email || '').toLowerCase();
  const p = await sa.getProductRaw(productId);
  if (!p) return { removed: 0, error: 'product not found' };

  if (opts.pooled) {
    const base = (p.variants || [])[0];
    if (!base) return { removed: 0, error: 'no variant' };
    const cur = await sa.getDeliverables(productId, base.id);
    const kept = cur.filter(l => String(l).split('|')[0].split(':')[0].trim().toLowerCase() !== email);
    if (kept.length === cur.length) return { removed: 0 };          // not found → nothing to do
    await sa.overwriteStock(productId, base.id, kept);
    return { removed: cur.length - kept.length };
  }

  // Per-account-variant product: rebuild the product WITHOUT the target variant
  // (full-replace omits it → SellAuth deletes it). Other variants/stock untouched.
  const variants = (p.variants || []).filter(v => v.id !== opts.variantId);
  if (variants.length === (p.variants || []).length) return { removed: 0 }; // id not present
  if (!variants.length) {
    // Removing the last variant would leave an invalid product — clear its stock
    // instead (overwrite empty) so the product stays valid but empty.
    try { await sa.overwriteStock(productId, opts.variantId, []); } catch {}
    return { removed: 1, emptied: true };
  }
  await sa.updateProduct(productId, sa.buildProductUpdate(p, variants));
  return { removed: 1 };
}

module.exports = { classifyAccount, classifyProduct, parseLine, aggregate, buildDescription, accountVariantName, accountVariantDescription, syncAccounts, syncAllStock, setVariantDescription, addAccountVariants, splitProductAccountVariants, splitAllAccountVariants, removeAccountFromProduct };
