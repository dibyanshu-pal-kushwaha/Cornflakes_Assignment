import { Router, Response } from 'express';
import { z } from 'zod';
import { WalletService } from '../services/wallet.service.js';
import { AuthenticatedRequest, authenticateJWT } from '../middleware/auth.js';
import { recordReserveAttempt } from '../middleware/metrics.js';
import { query } from '../db/connection.js';

export const walletRouter = Router();

// Validation Schemas
const QuoteSchema = z.object({
  amount: z.number().int().positive(),
});

const ReserveSchema = z.object({
  amount: z.number().int().positive(),
  ttl_seconds: z.number().int().positive().optional(),
});

const CommitSchema = z.object({
  reservation_id: z.string().uuid(),
});

const ReleaseSchema = z.object({
  reservation_id: z.string().uuid(),
});

/**
 * GET /v1/wallet - Read wallet balance and active buckets (safe cache + Postgres fallback)
 */
walletRouter.get('/wallet', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const wallet = await WalletService.getOrCreateWallet(userId);

    // Fetch active credit buckets breakdown
    const bucketsRes = await query(
      `SELECT id, source, amount_issued, amount_remaining, amount_reserved, expires_at
       FROM credit_buckets
       WHERE wallet_id = $1 AND amount_remaining > 0
       ORDER BY expires_at ASC`,
      [wallet.id]
    );

    res.json({
      wallet: {
        id: wallet.id,
        user_id: wallet.user_id,
        balance: Number(wallet.balance),
        spendable_balance: Number(wallet.balance) - Number(wallet.reserved_balance),
        reserved_balance: Number(wallet.reserved_balance),
        receivable_balance: Number(wallet.receivable_balance),
        currency: wallet.currency,
        status: wallet.status,
        version: Number(wallet.version),
      },
      buckets: bucketsRes.rows.map((b) => ({
        id: b.id,
        source: b.source,
        issued: Number(b.amount_issued),
        remaining: Number(b.amount_remaining),
        reserved: Number(b.amount_reserved),
        available: Number(b.amount_remaining) - Number(b.amount_reserved),
        expires_at: b.expires_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /v1/ledger?cursor= - Cursor-based stable pagination of ledger entries
 */
walletRouter.get('/ledger', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const wallet = await WalletService.getOrCreateWallet(userId);
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const result = await WalletService.getLedger(wallet.id, cursor, limit);
    res.json({
      wallet_id: wallet.id,
      entries: result.entries,
      next_cursor: result.nextCursor,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /v1/quote - FIFO preview of bucket consumption without locking
 */
walletRouter.post('/quote', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parse = QuoteSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues });
      return;
    }

    const userId = req.user!.userId;
    const wallet = await WalletService.getOrCreateWallet(userId);
    const quote = await WalletService.quote(wallet.id, parse.data.amount);

    res.json(quote);
  } catch (err: any) {
    res.status(err.name === 'InsufficientCreditsError' ? 400 : 500).json({ error: err.message });
  }
});

/**
 * POST /v1/reserve - Reserve credits for generation (Idempotent with Idempotency-Key)
 */
walletRouter.post('/reserve', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    res.status(400).json({ error: 'Missing required Idempotency-Key header' });
    return;
  }

  const parse = ReserveSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const userId = req.user!.userId;
    const wallet = await WalletService.getOrCreateWallet(userId);

    const reservation = await WalletService.reserve(
      wallet.id,
      parse.data.amount,
      idempotencyKey,
      parse.data.ttl_seconds
    );

    recordReserveAttempt(true);
    res.status(201).json({ reservation });
  } catch (err: any) {
    recordReserveAttempt(false);
    const isClientError = err.name === 'InsufficientCreditsError' || err.message.includes('suspended');
    res.status(isClientError ? 400 : 500).json({ error: err.message });
  }
});

/**
 * POST /v1/commit - Commit active reservation (Idempotent with Idempotency-Key)
 */
walletRouter.post('/commit', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    res.status(400).json({ error: 'Missing required Idempotency-Key header' });
    return;
  }

  const parse = CommitSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const result = await WalletService.commit(parse.data.reservation_id, idempotencyKey);
    res.json({ status: 'committed', ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /v1/release - Release active reservation back to wallet
 */
walletRouter.post('/release', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  const parse = ReleaseSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const reservation = await WalletService.release(parse.data.reservation_id, idempotencyKey);
    res.json({ status: 'released', reservation });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
