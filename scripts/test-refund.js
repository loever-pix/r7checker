// Verify the refund-after-credit path closes the "fake balance" gap.
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();

const store = require('../lib/store');
const { hashPassword } = require('../lib/siteAuth');
const nowpayments = require('../lib/payments/nowpayments');

function head(s) { console.log('\n=== ' + s + ' ==='); }

(async () => {
  // Create a fresh test user
  const email = 'refund-test-' + Date.now() + '@test.local';
  const user = store.createUser(email, hashPassword('TestPassword12345'));
  const invoiceId = 'rt_' + Date.now();
  console.log('user id=' + user.id + ' balance=' + user.balance_cents);

  // 1. Simulate a $20 deposit row + credit it via the deposit flow
  head('Credit $20 via deposit flow');
  store.recordDeposit({ invoiceId, userId: user.id, amountUsd: 20, status: 'finished' });
  let r = nowpayments.handleIpn({ payment_id: invoiceId, payment_status: 'finished' });
  console.log('handleIpn:', r);
  console.log('balance after credit:', store.getUserById(user.id).balance_cents);

  // 2. Replay the same finished webhook — must NOT double credit
  head('Replay finished webhook (must be idempotent)');
  r = nowpayments.handleIpn({ payment_id: invoiceId, payment_status: 'finished' });
  console.log('handleIpn:', r);
  console.log('balance still:', store.getUserById(user.id).balance_cents);

  // 3. Now NOWPayments retroactively says it was refunded
  head('Now refund the deposit — balance must drop');
  r = nowpayments.handleIpn({ payment_id: invoiceId, payment_status: 'refunded' });
  console.log('handleIpn:', r);
  console.log('balance after refund:', store.getUserById(user.id).balance_cents);

  // 4. Replay the refund — must NOT double debit
  head('Replay refund (must be idempotent)');
  r = nowpayments.handleIpn({ payment_id: invoiceId, payment_status: 'refunded' });
  console.log('handleIpn:', r);
  console.log('balance still:', store.getUserById(user.id).balance_cents);

  // 5. Audit-trail consistency check
  head('Audit trail check');
  const txns = store.listTransactions(user.id, 100);
  console.log('txn count:', txns.length);
  for (const t of txns.slice().reverse()) {
    console.log('  ' + t.kind + ' ' + (t.amount_cents > 0 ? '+' : '') + t.amount_cents + ' bal_after=' + t.balance_after + ' ref=' + (t.ref || '-'));
  }
  const sum = txns.reduce((a, t) => a + t.amount_cents, 0);
  console.log('sum of txns:', sum);
  console.log('user.balance_cents:', store.getUserById(user.id).balance_cents);
  console.log(sum === store.getUserById(user.id).balance_cents ? 'PASS — audit balances' : 'FAIL — audit mismatch');

  // 6. Verify adminAdjust gates on bad reason
  head('adminAdjust requires a real reason');
  try { store.adminAdjust(user.id, 50, ''); console.log('FAIL — empty reason accepted'); }
  catch (e) { console.log('PASS — blocked:', e.message); }

  // 7. Verify cents > 0 still enforced
  head('creditBalance still rejects bad cents');
  try { store.creditBalance(user.id, -50, 'adjust'); console.log('FAIL — negative accepted'); }
  catch (e) { console.log('PASS — blocked:', e.message); }

  // Clean up: cascade delete via foreign key needs manual order
  store.db.prepare('DELETE FROM transactions WHERE user_id = ?').run(user.id);
  store.db.prepare('DELETE FROM deposits WHERE user_id = ?').run(user.id);
  store.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
})();
