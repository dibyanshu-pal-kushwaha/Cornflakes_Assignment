import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WalletService } from '../src/services/wallet.service.js';
import { LedgerInvariants } from '../src/ledger/invariants.js';
import { pool, withTransaction } from '../src/db/connection.js';

describe('Atomicity & Crash Invariance (Trap T5)', () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T5: Replica killed between debit and ledger write maintains strict atomicity', async () => {
    const userId = `t5_user_${Date.now()}`;
    const wallet = await WalletService.getOrCreateWallet(userId);
    await WalletService.grantCredits(wallet.id, 200, 'purchased', 't5_seed');

    const balBefore = (await WalletService.getWallet(wallet.id)).balance;

    // Simulate crash after debit but before ledger write commit
    let caught = false;
    try {
      await withTransaction(async (client) => {
        // Step 1: Wallet row updated
        await client.query('UPDATE wallets SET balance = balance - 100 WHERE id = $1', [wallet.id]);

        // Step 2: Connection terminated or replica killed mid-transaction
        throw new Error('REPLICA_CRASH_SIMULATION');
      });
    } catch (err: any) {
      caught = true;
      expect(err.message).toBe('REPLICA_CRASH_SIMULATION');
    }

    expect(caught).toBe(true);

    // Verify database state: no partial mutation persisted!
    const balAfter = (await WalletService.getWallet(wallet.id)).balance;
    expect(balAfter).toBe(balBefore);

    // Verify invariants
    const report = await LedgerInvariants.verifyAll();
    expect(report.allPassed).toBe(true);
  });
});
