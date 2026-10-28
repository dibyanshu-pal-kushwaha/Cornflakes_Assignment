import pg from 'pg';
import { BucketAllocation, BucketSource } from '../types/index.js';
import { ClockService } from '../services/clock.service.js';

export class InsufficientCreditsError extends Error {
  constructor(message = 'Insufficient available credits to satisfy request') {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

export class BucketManager {
  /**
   * Plans consumption across buckets using FIFO by earliest expires_at.
   * Locks candidate buckets for update to prevent race conditions.
   */
  static async planAndLockConsumption(
    client: pg.PoolClient,
    walletId: string,
    requiredAmount: number
  ): Promise<BucketAllocation[]> {
    if (requiredAmount <= 0) {
      throw new Error('Required amount must be positive');
    }

    const now = await ClockService.now();

    // Select eligible buckets with available credits, locking rows in consistent order
    const query = `
      SELECT id, source, amount_remaining, amount_reserved, expires_at
      FROM credit_buckets
      WHERE wallet_id = $1
        AND expires_at > $2
        AND (amount_remaining - amount_reserved) > 0
      ORDER BY expires_at ASC, id ASC
      FOR UPDATE
    `;

    const res = await client.query(query, [walletId, now]);
    const buckets = res.rows;

    let needed = requiredAmount;
    const allocations: BucketAllocation[] = [];

    for (const b of buckets) {
      const remaining = Number(b.amount_remaining);
      const reserved = Number(b.amount_reserved);
      const available = remaining - reserved;

      if (available <= 0) continue;

      const take = Math.min(needed, available);
      allocations.push({
        bucket_id: b.id,
        amount: take,
        source: b.source as BucketSource,
        expires_at: new Date(b.expires_at).toISOString(),
      });

      needed -= take;
      if (needed === 0) break;
    }

    if (needed > 0) {
      throw new InsufficientCreditsError(
        `Insufficient available credits. Needed ${requiredAmount}, shortfall: ${needed}`
      );
    }

    return allocations;
  }

  /**
   * Quote calculation without acquiring row locks (read-only)
   */
  static async quoteConsumption(
    client: pg.PoolClient,
    walletId: string,
    requiredAmount: number
  ): Promise<BucketAllocation[]> {
    const now = await ClockService.now();

    const query = `
      SELECT id, source, amount_remaining, amount_reserved, expires_at
      FROM credit_buckets
      WHERE wallet_id = $1
        AND expires_at > $2
        AND (amount_remaining - amount_reserved) > 0
      ORDER BY expires_at ASC, id ASC
    `;

    const res = await client.query(query, [walletId, now]);
    let needed = requiredAmount;
    const allocations: BucketAllocation[] = [];

    for (const b of res.rows) {
      const remaining = Number(b.amount_remaining);
      const reserved = Number(b.amount_reserved);
      const available = remaining - reserved;

      if (available <= 0) continue;

      const take = Math.min(needed, available);
      allocations.push({
        bucket_id: b.id,
        amount: take,
        source: b.source as BucketSource,
        expires_at: new Date(b.expires_at).toISOString(),
      });

      needed -= take;
      if (needed === 0) break;
    }

    if (needed > 0) {
      throw new InsufficientCreditsError(
        `Insufficient credits for quote. Needed ${requiredAmount}, shortfall: ${needed}`
      );
    }

    return allocations;
  }

  static async applyReservation(
    client: pg.PoolClient,
    allocations: BucketAllocation[]
  ): Promise<void> {
    for (const alloc of allocations) {
      await client.query(
        `UPDATE credit_buckets
         SET amount_reserved = amount_reserved + $1, updated_at = NOW()
         WHERE id = $2`,
        [alloc.amount, alloc.bucket_id]
      );
    }
  }

  static async applyCommit(
    client: pg.PoolClient,
    allocations: BucketAllocation[]
  ): Promise<void> {
    for (const alloc of allocations) {
      await client.query(
        `UPDATE credit_buckets
         SET amount_remaining = amount_remaining - $1,
             amount_reserved = amount_reserved - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [alloc.amount, alloc.bucket_id]
      );
    }
  }

  static async applyRelease(
    client: pg.PoolClient,
    allocations: BucketAllocation[]
  ): Promise<void> {
    for (const alloc of allocations) {
      await client.query(
        `UPDATE credit_buckets
         SET amount_reserved = GREATEST(0, amount_reserved - $1),
             updated_at = NOW()
         WHERE id = $2`,
        [alloc.amount, alloc.bucket_id]
      );
    }
  }
}
