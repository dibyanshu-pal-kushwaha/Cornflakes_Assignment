import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WalletService } from '../src/services/wallet.service.js';
import { SchedulerService } from '../src/services/scheduler.service.js';
import { ClockService } from '../src/services/clock.service.js';
import { pool, query } from '../src/db/connection.js';

describe('Concurrency & Non-Overspend (Trap T4)', () => {
  beforeAll(async () => {
    await migrate();
  });

  beforeEach(async () => {
    await ClockService.reset();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T4: 100 parallel reserves against a balance for 10 -> exactly 10 succeed, never negative', async () => {
    const userId = `t4_user_${Date.now()}_${Math.random()}`;
    const wallet = await WalletService.getOrCreateWallet(userId);

    // Initial grant: exactly 10 credits
    await WalletService.grantCredits(wallet.id, 10, 'purchased', 't4_initial_grant', `grant_t4_${Date.now()}`);

    let successes = 0;
    let failures = 0;

    // Concurrently trigger 100 reserve requests of 1 credit each
    const promises = Array.from({ length: 100 }).map(async (_, idx) => {
      try {
        await WalletService.reserve(wallet.id, 1, `t4_res_${idx}_${Date.now()}_${Math.random()}`);
        successes++;
      } catch (err: any) {
        failures++;
      }
    });

    await Promise.all(promises);

    expect(successes).toBe(10);
    expect(failures).toBe(90);

    const updatedWallet = await WalletService.getWallet(wallet.id);
    expect(Number(updatedWallet.balance)).toBe(10);
    expect(Number(updatedWallet.reserved_balance)).toBe(10);
    expect(Number(updatedWallet.balance) - Number(updatedWallet.reserved_balance)).toBe(0);

    // Unfinished reservations expire and release automatically
    // Advance virtual clock by 16 minutes (TTL is 15 minutes)
    await ClockService.advanceSeconds(16 * 60);

    await SchedulerService.releaseExpiredReservations();

    // Verify all active reservations for this wallet have expired & released
    const activeRes = await query(
      "SELECT COUNT(*) FROM reservations WHERE wallet_id = $1 AND status = 'active'",
      [wallet.id]
    );
    expect(Number(activeRes.rows[0].count)).toBe(0);

    const restoredWallet = await WalletService.getWallet(wallet.id);
    expect(Number(restoredWallet.reserved_balance)).toBe(0);
    expect(Number(restoredWallet.balance)).toBe(10); // Spendable balance restored cleanly!
  });
});
