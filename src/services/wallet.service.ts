import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db/connection.js';
import { LedgerEngine } from '../ledger/engine.js';
import { BucketManager, InsufficientCreditsError } from '../ledger/buckets.js';
import { WalletCache } from '../cache/wallet.cache.js';
import { ClockService } from './clock.service.js';
import { BucketSource, Wallet, Reservation, BucketAllocation } from '../types/index.js';

export class WalletService {
  /**
   * Retrieves or creates a wallet for a user.
   */
  static async getOrCreateWallet(userId: string, orgId: string | null = null): Promise<Wallet> {
    const existing = await query<Wallet>('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const created = await query<Wallet>(
      `INSERT INTO wallets (id, user_id, org_id, balance, reserved_balance, receivable_balance, currency, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 0, 0, 0, 'USD', 'active', 1, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [uuidv4(), userId, orgId]
    );
    const wallet = created.rows[0];
    await WalletCache.set(wallet);
    return wallet;
  }

  /**
   * Safe balance read:
   * Uses Redis cache with version validation, falls back to Postgres.
   */
  static async getWallet(walletId: string, expectedMinVersion?: number): Promise<Wallet> {
    const cached = await WalletCache.get(walletId, expectedMinVersion);
    if (cached) {
      return {
        id: cached.id,
        user_id: cached.user_id,
        org_id: null,
        balance: cached.balance,
        reserved_balance: cached.reserved_balance,
        receivable_balance: cached.receivable_balance,
        currency: 'USD',
        status: cached.status as any,
        version: cached.version,
        created_at: new Date(cached.cached_at),
        updated_at: new Date(cached.cached_at),
      };
    }

    const res = await query<Wallet>('SELECT * FROM wallets WHERE id = $1', [walletId]);
    if (res.rows.length === 0) {
      throw new Error(`Wallet not found: ${walletId}`);
    }
    const wallet = res.rows[0];
    await WalletCache.set(wallet);
    return wallet;
  }

  /**
   * Stable cursor-based pagination for ledger entries.
   */
  static async getLedger(walletId: string, cursor?: string, limit = 20): Promise<{
    entries: any[];
    nextCursor: string | null;
  }> {
    let sql = `
      SELECT le.id, le.transaction_id, le.account_id, le.amount, le.bucket_id, le.created_at,
             lt.type as transaction_type, lt.description, lt.reference_id
      FROM ledger_entries le
      JOIN ledger_transactions lt ON le.transaction_id = lt.id
      WHERE le.wallet_id = $1
    `;
    const params: any[] = [walletId];

    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const [cursorTime, cursorId] = decoded.split('|');
      sql += ` AND (le.created_at, le.id) < ($2, $3)`;
      params.push(new Date(cursorTime), cursorId);
    }

    sql += ` ORDER BY le.created_at DESC, le.id DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const res = await query(sql, params);
    const hasMore = res.rows.length > limit;
    const items = hasMore ? res.rows.slice(0, limit) : res.rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      const cursorStr = `${new Date(last.created_at).toISOString()}|${last.id}`;
      nextCursor = Buffer.from(cursorStr, 'utf8').toString('base64');
    }

    return { entries: items, nextCursor };
  }

  /**
   * Quotes bucket consumption according to FIFO expiry without locks.
   */
  static async quote(walletId: string, amount: number): Promise<{
    wallet_id: string;
    amount: number;
    allocations: BucketAllocation[];
  }> {
    const client = await query('SELECT 1');
    const allocations = await withTransaction(async (txClient) => {
      return BucketManager.quoteConsumption(txClient, walletId, amount);
    });
    return { wallet_id: walletId, amount, allocations };
  }

  /**
   * Grants credits to a wallet with a balanced double-entry transaction and creates a bucket.
   */
  static async grantCredits(
    walletId: string,
    amount: number,
    source: BucketSource,
    referenceId?: string,
    idempotencyKey?: string,
    expiresAt?: Date
  ): Promise<{ transactionId: string; bucketId: string; newBalance: number }> {
    if (amount <= 0) throw new Error('Grant amount must be positive');

    return withTransaction(async (client) => {
      // Check idempotency if key provided
      if (idempotencyKey) {
        const existingTx = await client.query(
          'SELECT id FROM ledger_transactions WHERE idempotency_key = $1',
          [idempotencyKey]
        );
        if (existingTx.rows.length > 0) {
          const w = await client.query('SELECT balance FROM wallets WHERE id = $1', [walletId]);
          return {
            transactionId: existingTx.rows[0].id,
            bucketId: '',
            newBalance: Number(w.rows[0]?.balance || 0),
          };
        }
      }

      // Lock wallet for update
      const wRes = await client.query(
        'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
        [walletId]
      );
      if (wRes.rows.length === 0) throw new Error(`Wallet ${walletId} not found`);
      const wallet = wRes.rows[0];

      // Calculate default expiry based on source
      const now = await ClockService.now();
      let calculatedExpiry = expiresAt;
      if (!calculatedExpiry) {
        if (source === 'purchased') {
          calculatedExpiry = new Date(now.getTime() + 365 * 86400 * 1000); // 12 months
        } else if (source === 'subscription') {
          calculatedExpiry = new Date(now.getTime() + 30 * 86400 * 1000); // end of cycle / 30 days
        } else {
          calculatedExpiry = new Date(now.getTime() + 30 * 86400 * 1000); // promo: 30 days
        }
      }

      // Create bucket
      const bucketId = uuidv4();
      await client.query(
        `INSERT INTO credit_buckets (id, wallet_id, source, amount_issued, amount_remaining, amount_reserved, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 0, $5, $6, $6)`,
        [bucketId, walletId, source, amount, calculatedExpiry, now]
      );

      // Record balanced double-entry:
      // system:grants (-amount) -> wallet:<walletId> (+amount)
      const txType = source === 'subscription' ? 'grant_subscription' : source === 'promo' ? 'grant_promo' : 'grant_purchase';
      const txId = await LedgerEngine.recordTransaction(client, {
        type: txType,
        referenceId: referenceId || bucketId,
        idempotencyKey: idempotencyKey || null,
        description: `Credit grant of ${amount} (${source})`,
        entries: [
          { accountId: 'system:grants', amount: -amount },
          { accountId: `wallet:${walletId}`, walletId, bucketId, amount: amount },
        ],
      });

      // Update wallet balance and increment version
      const updated = await client.query(
        `UPDATE wallets
         SET balance = balance + $1, version = version + 1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [amount, walletId]
      );

      const updatedWallet = updated.rows[0];
      await WalletCache.set(updatedWallet);

      return {
        transactionId: txId,
        bucketId,
        newBalance: Number(updatedWallet.balance),
      };
    });
  }

  /**
   * Reserves credits for generation.
   * Concurrency safe via SELECT ... FOR UPDATE on wallet and buckets.
   */
  static async reserve(
    walletId: string,
    amount: number,
    idempotencyKey: string,
    ttlSeconds = 900 // 15 mins default
  ): Promise<Reservation> {
    return withTransaction(async (client) => {
      // Idempotency check: if already processed, return existing
      const existing = await client.query(
        'SELECT * FROM reservations WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0];
      }

      // Lock wallet row strictly
      const wRes = await client.query(
        'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
        [walletId]
      );
      if (wRes.rows.length === 0) throw new Error(`Wallet ${walletId} not found`);
      const wallet = wRes.rows[0];

      if (wallet.status === 'suspended') {
        throw new Error('Wallet is suspended');
      }

      const available = Number(wallet.balance) - Number(wallet.reserved_balance);
      if (available < amount) {
        throw new InsufficientCreditsError(
          `Insufficient available balance. Available: ${available}, Required: ${amount}`
        );
      }

      // Plan and lock required buckets
      const allocations = await BucketManager.planAndLockConsumption(client, walletId, amount);

      // Lock buckets by applying reservation increment
      await BucketManager.applyReservation(client, allocations);

      const now = await ClockService.now();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const resId = uuidv4();

      await client.query(
        `INSERT INTO reservations (id, wallet_id, idempotency_key, amount, status, bucket_allocations, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $7)`,
        [resId, walletId, idempotencyKey, amount, JSON.stringify(allocations), expiresAt, now]
      );

      // Update wallet reserved_balance and bump version
      const wUpdate = await client.query(
        `UPDATE wallets
         SET reserved_balance = reserved_balance + $1, version = version + 1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [amount, walletId]
      );

      await WalletCache.set(wUpdate.rows[0]);

      return {
        id: resId,
        wallet_id: walletId,
        idempotency_key: idempotencyKey,
        amount,
        status: 'active',
        bucket_allocations: allocations,
        expires_at: expiresAt,
        created_at: now,
        updated_at: now,
      };
    });
  }

  /**
   * Commits an active reservation: writes debit to ledger and updates wallet & buckets.
   */
  static async commit(
    reservationId: string,
    idempotencyKey: string
  ): Promise<{ transactionId: string; reservation: Reservation }> {
    return withTransaction(async (client) => {
      // Check if commit already recorded for idempotency
      const existingTx = await client.query(
        "SELECT id FROM ledger_transactions WHERE idempotency_key = $1 AND type = 'commit'",
        [idempotencyKey]
      );
      if (existingTx.rows.length > 0) {
        const res = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
        return { transactionId: existingTx.rows[0].id, reservation: res.rows[0] };
      }

      const rRes = await client.query(
        'SELECT * FROM reservations WHERE id = $1 FOR UPDATE',
        [reservationId]
      );
      if (rRes.rows.length === 0) throw new Error(`Reservation ${reservationId} not found`);
      const reservation = rRes.rows[0];

      if (reservation.status !== 'active') {
        throw new Error(`Reservation cannot be committed. Current status: ${reservation.status}`);
      }

      const walletId = reservation.wallet_id;
      const amount = Number(reservation.amount);
      const allocations: BucketAllocation[] = reservation.bucket_allocations;

      // Lock wallet
      const wRes = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
      const wallet = wRes.rows[0];

      // Deduct from bucket remaining & reserved
      await BucketManager.applyCommit(client, allocations);

      // Double-entry record:
      // wallet:<walletId> (-amount) -> system:revenue (+amount)
      const entries: any[] = [
        { accountId: 'system:revenue', amount: amount },
      ];
      for (const alloc of allocations) {
        entries.push({
          accountId: `wallet:${walletId}`,
          walletId,
          bucketId: alloc.bucket_id,
          amount: -alloc.amount,
        });
      }

      const txId = await LedgerEngine.recordTransaction(client, {
        type: 'commit',
        referenceId: reservationId,
        idempotencyKey,
        description: `Commit generation reservation ${reservationId}`,
        entries,
      });

      // Update wallet balance & reserved_balance
      const wUpdate = await client.query(
        `UPDATE wallets
         SET balance = balance - $1,
             reserved_balance = reserved_balance - $1,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [amount, walletId]
      );

      // Mark reservation committed
      const resUpdate = await client.query(
        `UPDATE reservations
         SET status = 'committed', updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [reservationId]
      );

      await WalletCache.set(wUpdate.rows[0]);

      return {
        transactionId: txId,
        reservation: resUpdate.rows[0],
      };
    });
  }

  /**
   * Releases an active reservation: returns reserved credits back to spendable balance.
   */
  static async release(
    reservationId: string,
    idempotencyKey?: string
  ): Promise<Reservation> {
    return withTransaction(async (client) => {
      const rRes = await client.query(
        'SELECT * FROM reservations WHERE id = $1 FOR UPDATE',
        [reservationId]
      );
      if (rRes.rows.length === 0) throw new Error(`Reservation ${reservationId} not found`);
      const reservation = rRes.rows[0];

      if (reservation.status !== 'active') {
        // Idempotent return if already released
        if (reservation.status === 'released') return reservation;
        throw new Error(`Reservation status is ${reservation.status}, cannot release`);
      }

      const walletId = reservation.wallet_id;
      const amount = Number(reservation.amount);
      const allocations: BucketAllocation[] = reservation.bucket_allocations;

      // Lock wallet
      const wRes = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);

      // Release reserved amounts from buckets
      await BucketManager.applyRelease(client, allocations);

      // Decrease reserved_balance
      const wUpdate = await client.query(
        `UPDATE wallets
         SET reserved_balance = GREATEST(0, reserved_balance - $1),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [amount, walletId]
      );

      const resUpdate = await client.query(
        `UPDATE reservations
         SET status = 'released', updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [reservationId]
      );

      await WalletCache.set(wUpdate.rows[0]);
      return resUpdate.rows[0];
    });
  }
}
