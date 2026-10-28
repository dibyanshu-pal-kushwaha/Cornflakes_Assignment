import { v4 as uuidv4 } from 'uuid';
import { WalletService } from '../src/services/wallet.service.js';
import { WebhookService } from '../src/services/webhook.service.js';
import { OutboxWorker } from '../src/services/outbox.worker.js';
import { MockGateway } from '../src/mockGateway/gateway.js';
import { LedgerInvariants } from '../src/ledger/invariants.js';
import { WalletCache } from '../src/cache/wallet.cache.js';
import { pool, withTransaction, query } from '../src/db/connection.js';

async function runChaosSuite() {
  console.log('================================================================');
  console.log('             CORNFLAKES MEDIA - CHAOS TEST SUITE                ');
  console.log('================================================================\n');

  // ----------------------------------------------------------------
  // Trap T1: Same webhook delivered 5 times concurrently
  // ----------------------------------------------------------------
  console.log('[CHAOS T1] Testing 5 concurrent deliveries of the EXACT same webhook...');
  const t1User = `user_chaos_t1_${Date.now()}`;
  const t1Payment = MockGateway.createPayment(t1User, 2000, 200); // 200 credits
  const rawBody = JSON.stringify(t1Payment.payload);

  // Send 5 identical webhooks concurrently
  const promises = Array.from({ length: 5 }).map(() =>
    WebhookService.ingest(rawBody, t1Payment.signature)
  );
  const intakeResults = await Promise.all(promises);
  console.log('Intake statuses:', intakeResults.map((r) => r.status));

  // Process outbox
  await OutboxWorker.processBatch(20);

  // Verify wallet
  const t1Wallet = await WalletService.getOrCreateWallet(t1User);
  console.log(`User balance after 5 deliveries: ${t1Wallet.balance} (Expected: exactly 200)`);
  if (Number(t1Wallet.balance) !== 200) {
    throw new Error(`T1 FAILED: Expected balance 200, got ${t1Wallet.balance}`);
  }

  // Count ledger entries for this payment
  const t1TxCount = await query(
    'SELECT COUNT(*) FROM ledger_transactions WHERE reference_id = $1',
    [t1Payment.payment_id]
  );
  console.log(`Ledger transaction count: ${t1TxCount.rows[0].count} (Expected: 1)`);
  if (Number(t1TxCount.rows[0].count) !== 1) {
    throw new Error(`T1 FAILED: Multiple ledger entries written`);
  }
  console.log('--> T1 PASSED: Exactly one credit and one ledger entry.\n');

  // ----------------------------------------------------------------
  // Trap T4: 100 parallel reserves against a balance of 10
  // ----------------------------------------------------------------
  console.log('[CHAOS T4] Testing 100 parallel reserves against a balance for 10...');
  const t4User = `user_chaos_t4_${Date.now()}`;
  const t4Wallet = await WalletService.getOrCreateWallet(t4User);
  // Grant exactly 10 credits
  await WalletService.grantCredits(t4Wallet.id, 10, 'purchased', 'chaos_t4_initial');

  let successCount = 0;
  let failCount = 0;

  // Race 100 reserves of 1 credit each concurrently
  const reservePromises = Array.from({ length: 100 }).map(async (_, idx) => {
    try {
      await WalletService.reserve(t4Wallet.id, 1, `res_t4_${idx}_${Date.now()}`);
      successCount++;
    } catch {
      failCount++;
    }
  });
  await Promise.all(reservePromises);

  const updatedT4 = await WalletService.getWallet(t4Wallet.id);
  console.log(`100 parallel reserves finished: Successes=${successCount}, Failures=${failCount}`);
  console.log(`Reserved balance: ${updatedT4.reserved_balance}, Balance: ${updatedT4.balance}`);

  if (successCount !== 10) {
    throw new Error(`T4 FAILED: Expected exactly 10 successes, got ${successCount}`);
  }
  if (Number(updatedT4.balance) < 0 || Number(updatedT4.reserved_balance) > Number(updatedT4.balance)) {
    throw new Error(`T4 FAILED: Negative balance or overspend occurred!`);
  }
  console.log('--> T4 PASSED: Exactly 10 succeeded, zero overspend, balance never negative.\n');

  // ----------------------------------------------------------------
  // Trap T5: Atomic rollback simulation (replica killed mid-transaction)
  // ----------------------------------------------------------------
  console.log('[CHAOS T5] Testing atomic rollback when transaction fails mid-flight...');
  const t5User = `user_chaos_t5_${Date.now()}`;
  const t5Wallet = await WalletService.getOrCreateWallet(t5User);
  await WalletService.grantCredits(t5Wallet.id, 100, 'purchased', 'chaos_t5_grant');
  const balBefore = (await WalletService.getWallet(t5Wallet.id)).balance;

  try {
    await withTransaction(async (client: any) => {
      // Step 1: Deduct balance
      await client.query('UPDATE wallets SET balance = balance - 50 WHERE id = $1', [t5Wallet.id]);

      // Step 2: Simulate crash / connection drop before ledger entry is written
      throw new Error('SIMULATED_REPLICA_CRASH_OR_CONNECTION_LOST');
    });
  } catch (err: any) {
    console.log(`Transaction intercepted: ${err.message}`);
  }

  const balAfter = (await WalletService.getWallet(t5Wallet.id)).balance;
  console.log(`Balance before: ${balBefore}, Balance after crash: ${balAfter}`);
  if (balBefore !== balAfter) {
    throw new Error('T5 FAILED: Non-atomic partial mutation persisted after crash!');
  }

  const t5Verification = await LedgerInvariants.verifyAll();
  if (!t5Verification.allPassed) {
    throw new Error('T5 FAILED: Invariants corrupted after simulated crash');
  }
  console.log('--> T5 PASSED: Atomic rollback guarantees both or neither; invariants hold.\n');

  // ----------------------------------------------------------------
  // Trap T9: Redis down or stale cache self-repairs
  // ----------------------------------------------------------------
  console.log('[CHAOS T9] Testing stale Redis cache auto-repair...');
  const t9User = `user_chaos_t9_${Date.now()}`;
  const t9Wallet = await WalletService.getOrCreateWallet(t9User);
  await WalletService.grantCredits(t9Wallet.id, 150, 'purchased', 'chaos_t9_grant');

  // Poison cache with an old stale balance (e.g. 50 with old version 1)
  await WalletCache.set({
    id: t9Wallet.id,
    user_id: t9Wallet.user_id,
    balance: 50,
    reserved_balance: 0,
    receivable_balance: 0,
    version: 1, // Stale version
    status: 'active',
  });

  // Read wallet with expected min version check (latest version from DB)
  const freshWallet = await WalletService.getWallet(t9Wallet.id, 2);
  console.log(`Read balance after cache poison: ${freshWallet.balance} (Expected: 150)`);

  if (Number(freshWallet.balance) !== 150) {
    throw new Error(`T9 FAILED: Stale cached balance ${freshWallet.balance} was served`);
  }
  console.log('--> T9 PASSED: Version stamp prevented stale cache read; repaired to truth.\n');

  console.log('================================================================');
  console.log('             ALL CHAOS SCENARIOS PASSED SAFELY!                 ');
  console.log('================================================================\n');

  await pool.end();
}

runChaosSuite().catch((err) => {
  console.error('[Chaos] Error:', err);
  process.exit(1);
});
