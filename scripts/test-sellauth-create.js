'use strict';
// THROWAWAY verification for the SellAuth create-by-clone + delete endpoints.
// Run this BEFORE the live VWI push to confirm product creation works on your shop.
//
//   node scripts/test-sellauth-create.js [templateProductId] [--keep]
//
// What it does:
//   1. Picks a template product (the id you pass, else the first product listed).
//   2. Clones it into a PRIVATE product "[TEST] DELETE ME — vwi probe" at $0.01
//      (private = never publicly visible, even briefly).
//   3. Prints the created product (id, name, variant id, price).
//   4. Deletes it again and confirms it's gone — UNLESS you pass --keep.
//
// It needs SellAuth credentials configured (lib/bot/config reads them from env/.env),
// so run it where the bot's SellAuth key is available. It creates exactly ONE
// private throwaway product and removes it; it never touches your real products.

const sa = require('./../lib/bot/sellauth');

const KEEP = process.argv.includes('--keep');
const argId = process.argv.slice(2).find(a => /^\d+$/.test(a));

(async () => {
  console.log('SellAuth create/delete verification\n');

  // 1. Resolve a template product.
  let templateId = argId ? Number(argId) : null;
  if (!templateId) {
    const products = await sa.listProducts();
    if (!products.length) { console.error('No products found to clone from. Pass a templateProductId.'); process.exit(1); }
    templateId = products[0].id;
    console.log(`Using first product as template: #${templateId} "${products[0].name}"`);
  } else {
    console.log(`Using template product #${templateId}`);
  }

  // 2. Create the throwaway clone (PRIVATE so it's never publicly visible).
  const name = '[TEST] DELETE ME — vwi probe';
  console.log(`\nCreating private clone "${name}" at $0.01 ...`);
  let created;
  try {
    created = await sa.createProductFromTemplate(templateId, {
      name, price: 0.01, visibility: 'private',
      variantName: 'test variant', variantDescription: 'throwaway — safe to delete',
    });
  } catch (e) {
    console.error('\n❌ CREATE FAILED:', e.message);
    if (e.body) console.error('   body:', JSON.stringify(e.body).slice(0, 600));
    process.exit(1);
  }
  console.log('✅ Created:', JSON.stringify({ id: created.id, name: created.name, variantId: created.variantId, price: created.price, stock: created.stock }, null, 0));

  if (KEEP) { console.log('\n--keep set: leaving the test product in place. Delete it manually when done.'); return; }

  // 3. Delete it and confirm.
  console.log(`\nDeleting test product #${created.id} ...`);
  try {
    await sa.deleteProduct(created.id);
  } catch (e) {
    console.error(`❌ DELETE FAILED for #${created.id}: ${e.message}. Delete it manually in SellAuth.`);
    process.exit(1);
  }
  let stillThere = true;
  try { await sa.getProduct(created.id); } catch { stillThere = false; }
  if (stillThere) { console.error(`⚠️  Product #${created.id} still exists after delete — remove it manually.`); process.exit(1); }

  console.log('✅ Deleted and verified gone.\n\n🎉 create + delete both work — the live push can create missing products safely.');
})().catch(e => { console.error('Unexpected error:', e); process.exit(1); });
