import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WalletService } from '../src/services/wallet.service.js';
import { SchedulerService } from '../src/services/scheduler.service.js';
import { ClockService } from '../src/services/clock.service.js';
import { LedgerInvariants } from '../src/ledger/invariants.js';
import { pool } from '../src/db/connection.js';

describe('Credit Expiry & Open Reservations (Trap T11)', () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T11: Credits expire while a reservation is open -> Reservation is honored cleanly and ledger remains balanced', async () => {
    const userId = `t11_user_${Date.now()}`;
    const wallet = await WalletService.getOrCreateWallet(userId);

    const now = await ClockService.now();
    // Grant 100 promo credits expiring in 10 minutes
    const shortExpiry = new Date(now.getTime() + 10 * 60 * 1000);
    await WalletService.grantCredits(
      wallet.id,
      100,
      'promo',
      't11_promo_grant',
      `t11_seed_${Date.now()}`,
      shortExpiry
    );

    // Open reservation for 40 credits
    const reservation = await WalletService.reserve(wallet.id, 40, `t11_res_${Date.now()}`);

    // Fast-forward time past credit expiry (e.g. +15 minutes)
    await ClockService.advanceSeconds(15 * 60);

    // Nightly expiry sweep runs
    const expiryResult = await SchedulerService.runCreditExpirySweep();

    // The unreserved 60 credits expired, while the 40 reserved credits were protected
    expect(expiryResult.totalCreditsExpired).toBe(60);

    // Generation completes and commits the 40 credits
    const commitRes = await WalletService.commit(reservation.id, `t11_commit_${Date.now()}`);
    expect(commitRes.transactionId).toBeDefined();

    const finalWallet = await WalletService.getWallet(wallet.id);
    expect(Number(finalWallet.balance)).toBe(0);
    expect(Number(finalWallet.reserved_balance)).toBe(0);

    // Ledger invariants must remain 100% verified and balanced
    const report = await LedgerInvariants.verifyAll();
    expect(report.allPassed).toBe(true);
  });
});
