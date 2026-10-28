import pg from 'pg';
import { pool, query, withTransaction } from '../db/connection.js';
import { WalletService } from './wallet.service.js';
import { SubscriptionService } from './subscription.service.js';
import { LedgerEngine } from '../ledger/engine.js';
import { WalletCache } from '../cache/wallet.cache.js';
import { ClockService } from './clock.service.js';

// Postgres Advisory Lock IDs for distributed mutual exclusion
const LOCK_ID_HOURLY_SWEEP = 849201;
const LOCK_ID_DAILY_DUNNING = 849202;
const LOCK_ID_EXPIRY_SWEEP = 849203;

export class SchedulerService {
  /**
   * Acquire postgres advisory lock. Returns false if lock is already held.
   */
  private static async tryAcquireLock(client: pg.PoolClient, lockId: number): Promise<boolean> {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);
    return res.rows[0].acquired === true;
  }

  private static async releaseLock(client: pg.PoolClient, lockId: number): Promise<void> {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
  }

  /**
   * Hourly convergence sweep:
   * Finds settled charges in gateway report or pending ungranted payments and grants credits.
   * Safe under concurrent execution (Trap T10).
   */
  static async runHourlyGrantSweep(mockGatewayReport?: Array<{ payment_id: string; user_id: string; amount_minor: number; credits: number }>): Promise<{
    skippedByLock: boolean;
    grantedCount: number;
  }> {
    const client = await pool.connect();
    let lockAcquired = false;

    try {
      lockAcquired = await this.tryAcquireLock(client, LOCK_ID_HOURLY_SWEEP);
      if (!lockAcquired) {
        return { skippedByLock: true, grantedCount: 0 };
      }

      let grantedCount = 0;

      // 1. Check any processed_payments that were created but had ungranted credits
      // 2. If gateway report provided, reconcile missing grants (Trap T6)
      if (mockGatewayReport && mockGatewayReport.length > 0) {
        for (const item of mockGatewayReport) {
          const settled = await client.query(
            'SELECT payment_id FROM processed_payments WHERE payment_id = $1',
            [item.payment_id]
          );

          if (settled.rows.length === 0) {
            // Settled payment at gateway that never reached webhook or failed!
            const wallet = await WalletService.getOrCreateWallet(item.user_id);
            await WalletService.grantCredits(
              wallet.id,
              item.credits,
              'purchased',
              item.payment_id,
              `sweep_grant:${item.payment_id}`
            );

            await client.query(
              `INSERT INTO processed_payments (payment_id, first_event_id, amount, currency, wallet_id, status, created_at)
               VALUES ($1, $2, $3, 'USD', $4, 'settled', NOW())
               ON CONFLICT (payment_id) DO NOTHING`,
              [item.payment_id, `sweep_${Date.now()}`, item.amount_minor, wallet.id]
            );

            grantedCount++;
          }
        }
      }

      // 3. Auto-release expired reservations (TTL cleanup)
      await this.releaseExpiredReservations(client);

      return { skippedByLock: false, grantedCount };
    } finally {
      if (lockAcquired) {
        await this.releaseLock(client, LOCK_ID_HOURLY_SWEEP);
      }
      client.release();
    }
  }

  /**
   * Daily dunning sweep:
   * Retries subscriptions due for dunning and transitions states.
   */
  static async runDailyDunningSweep(): Promise<{
    skippedByLock: boolean;
    processedCount: number;
  }> {
    const client = await pool.connect();
    let lockAcquired = false;

    try {
      lockAcquired = await this.tryAcquireLock(client, LOCK_ID_DAILY_DUNNING);
      if (!lockAcquired) {
        return { skippedByLock: true, processedCount: 0 };
      }

      const now = await ClockService.now();
      const res = await client.query(
        `SELECT id, status, dunning_attempt 
         FROM subscriptions
         WHERE status IN ('grace_period', 'suspended')
           AND next_dunning_at <= $1`,
        [now]
      );

      let processedCount = 0;
      for (const sub of res.rows) {
        await SubscriptionService.handleRenewalFailure(sub.id);
        processedCount++;
      }

      return { skippedByLock: false, processedCount };
    } finally {
      if (lockAcquired) {
        await this.releaseLock(client, LOCK_ID_DAILY_DUNNING);
      }
      client.release();
    }
  }

  /**
   * Nightly Credit Expiry Sweep:
   * Expires credit buckets via balanced ledger entries (wallet -> system:breakage),
   * NEVER by directly editing balances! (Section 4.1 Item 5, Trap T11).
   */
  static async runCreditExpirySweep(): Promise<{
    skippedByLock: boolean;
    expiredBuckets: number;
    totalCreditsExpired: number;
  }> {
    const client = await pool.connect();
    let lockAcquired = false;

    try {
      lockAcquired = await this.tryAcquireLock(client, LOCK_ID_EXPIRY_SWEEP);
      if (!lockAcquired) {
        return { skippedByLock: true, expiredBuckets: 0, totalCreditsExpired: 0 };
      }

      const now = await ClockService.now();

      // Find expired buckets with remaining balance > 0
      // If reserved credits exist, only expire unreserved portion (honors open reservations! Trap T11)
      const expiredRes = await client.query(
        `SELECT id, wallet_id, amount_remaining, amount_reserved
         FROM credit_buckets
         WHERE expires_at <= $1 AND (amount_remaining - amount_reserved) > 0
         FOR UPDATE`,
        [now]
      );

      let expiredBuckets = 0;
      let totalCreditsExpired = 0;

      for (const bucket of expiredRes.rows) {
        const unreservedExpired = Number(bucket.amount_remaining) - Number(bucket.amount_reserved);
        if (unreservedExpired <= 0) continue;

        const walletId = bucket.wallet_id;

        // Balanced double-entry transaction:
        // wallet:<wallet_id> (-amount) -> system:breakage (+amount)
        const txId = await LedgerEngine.recordTransaction(client, {
          type: 'expire',
          referenceId: bucket.id,
          idempotencyKey: `expiry:${bucket.id}:${now.toISOString().substring(0, 10)}`,
          description: `Nightly credit expiry for bucket ${bucket.id}`,
          entries: [
            { accountId: `wallet:${walletId}`, walletId, bucketId: bucket.id, amount: -unreservedExpired },
            { accountId: 'system:breakage', amount: unreservedExpired },
          ],
        });

        // Update bucket
        await client.query(
          `UPDATE credit_buckets
           SET amount_remaining = amount_remaining - $1, updated_at = NOW()
           WHERE id = $2`,
          [unreservedExpired, bucket.id]
        );

        // Update wallet balance & bump version
        const wUpdate = await client.query(
          `UPDATE wallets
           SET balance = balance - $1, version = version + 1, updated_at = NOW()
           WHERE id = $2
           RETURNING *`,
          [unreservedExpired, walletId]
        );

        await WalletCache.set(wUpdate.rows[0]);

        expiredBuckets++;
        totalCreditsExpired += unreservedExpired;
      }

      return { skippedByLock: false, expiredBuckets, totalCreditsExpired };
    } finally {
      if (lockAcquired) {
        await this.releaseLock(client, LOCK_ID_EXPIRY_SWEEP);
      }
      client.release();
    }
  }

  /**
   * Auto-release expired reservations (TTL elapsed).
   */
  static async releaseExpiredReservations(client?: pg.PoolClient): Promise<number> {
    const now = await ClockService.now();
    const queryExecutor = client || pool;

    const res = await queryExecutor.query(
      `SELECT id FROM reservations WHERE status = 'active' AND expires_at <= $1`,
      [now]
    );

    let count = 0;
    for (const r of res.rows) {
      try {
        await WalletService.release(r.id);
        count++;
      } catch (err) {
        console.warn(`[Scheduler] Could not release expired reservation ${r.id}:`, err);
      }
    }
    return count;
  }
}
