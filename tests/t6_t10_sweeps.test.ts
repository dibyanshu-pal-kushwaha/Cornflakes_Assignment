import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { SchedulerService } from '../src/services/scheduler.service.js';
import { WalletService } from '../src/services/wallet.service.js';
import { query, pool } from '../src/db/connection.js';

describe('Convergence Sweeps & Distributed Locking (T6, T10)', () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T6: Renewal webhook never arrives -> Hourly sweep grants credits exactly once', async () => {
    const userId = `t6_user_${Date.now()}`;
    const paymentId = `pay_t6_lost_${Date.now()}`;

    // Gateway reports this payment settled, but webhook never reached server!
    const gatewayReport = [
      {
        payment_id: paymentId,
        user_id: userId,
        amount_minor: 4000,
        credits: 400,
        status: 'settled' as const,
      },
    ];

    // Sweep runs
    const sweep1 = await SchedulerService.runHourlyGrantSweep(gatewayReport as any);
    expect(sweep1.grantedCount).toBe(1);

    const wallet = await WalletService.getOrCreateWallet(userId);
    expect(Number(wallet.balance)).toBe(400);

    // Run sweep again -> idempotent, exactly once!
    const sweep2 = await SchedulerService.runHourlyGrantSweep(gatewayReport as any);
    expect(sweep2.grantedCount).toBe(0);

    const walletAfter = await WalletService.getWallet(wallet.id);
    expect(Number(walletAfter.balance)).toBe(400); // Not 800!
  });

  it('T10: Two sweeps start at the same moment -> Postgres advisory lock ensures no double grants', async () => {
    const userId = `t10_user_${Date.now()}`;
    const paymentId = `pay_t10_race_${Date.now()}`;

    const gatewayReport = [
      {
        payment_id: paymentId,
        user_id: userId,
        amount_minor: 5000,
        credits: 500,
        status: 'settled' as const,
      },
    ];

    // Race two sweeps concurrently at the exact same millisecond
    const [sweepA, sweepB] = await Promise.all([
      SchedulerService.runHourlyGrantSweep(gatewayReport as any),
      SchedulerService.runHourlyGrantSweep(gatewayReport as any),
    ]);

    // One sweep acquired the advisory lock, the other was skipped safely or granted 0 duplicates
    const totalGranted = sweepA.grantedCount + sweepB.grantedCount;
    expect(totalGranted).toBe(1);

    const wallet = await WalletService.getOrCreateWallet(userId);
    expect(Number(wallet.balance)).toBe(500);
  });
});
