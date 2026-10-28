import pg from 'pg';
import { withTransaction, query } from '../db/connection.js';
import { LedgerEngine } from '../ledger/engine.js';
import { WalletCache } from '../cache/wallet.cache.js';
import { ClockService } from './clock.service.js';

export interface RefundResult {
  paymentId: string;
  walletId: string;
  refundedCredits: number;
  clawedBackCredits: number;
  shortfallReceivable: number;
  suspended: boolean;
  transactionId: string;
}

export class RefundService {
  /**
   * Processes a refund according to policy:
   * 1. Claws back available balance in the wallet (without making balance negative)
   * 2. Any shortfall is recorded as an accounts receivable (receivable_balance)
   * 3. Repeated abuse (>1 shortfall or flagged) sets wallet status = 'suspended'
   */
  static async processRefund(
    paymentId: string,
    refundCredits: number,
    referenceEventId: string
  ): Promise<RefundResult> {
    return withTransaction(async (client) => {
      // Find the settled payment record
      const pRes = await client.query(
        'SELECT * FROM processed_payments WHERE payment_id = $1 FOR UPDATE',
        [paymentId]
      );
      if (pRes.rows.length === 0) {
        throw new Error(`PAYMENT_NOT_FOUND:${paymentId}`);
      }
      const payment = pRes.rows[0];
      const walletId = payment.wallet_id;

      // Lock wallet
      const wRes = await client.query(
        'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
        [walletId]
      );
      const wallet = wRes.rows[0];

      const currentBalance = Number(wallet.balance);
      const clawedBack = Math.min(currentBalance, refundCredits);
      const shortfall = refundCredits - clawedBack;

      // Deduct clawed back amount from newest/active buckets
      if (clawedBack > 0) {
        let needed = clawedBack;
        const bRes = await client.query(
          `SELECT id, amount_remaining, amount_reserved
           FROM credit_buckets
           WHERE wallet_id = $1 AND amount_remaining > 0
           ORDER BY created_at DESC
           FOR UPDATE`,
          [walletId]
        );
        for (const bucket of bRes.rows) {
          const rem = Number(bucket.amount_remaining);
          const take = Math.min(needed, rem);
          await client.query(
            `UPDATE credit_buckets
             SET amount_remaining = amount_remaining - $1, updated_at = NOW()
             WHERE id = $2`,
            [take, bucket.id]
          );
          needed -= take;
          if (needed === 0) break;
        }
      }

      // Prepare double-entry entries
      const entries: any[] = [];
      if (clawedBack > 0) {
        entries.push(
          { accountId: `wallet:${walletId}`, walletId, amount: -clawedBack },
          { accountId: 'system:clawback', amount: clawedBack }
        );
      }
      if (shortfall > 0) {
        entries.push(
          { accountId: 'system:receivables', amount: -shortfall },
          { accountId: 'system:clawback', amount: shortfall }
        );
      }

      const txId = await LedgerEngine.recordTransaction(client, {
        type: 'refund_clawback',
        referenceId: paymentId,
        idempotencyKey: `refund:${paymentId}:${referenceEventId}`,
        description: `Refund clawback for payment ${paymentId}. Clawed: ${clawedBack}, Shortfall: ${shortfall}`,
        entries,
      });

      // Update wallet balance, receivable, and check suspension policy
      const newBalance = currentBalance - clawedBack;
      const newReceivable = Number(wallet.receivable_balance) + shortfall;

      // Policy: If customer has experienced multiple shortfalls, suspend wallet
      let shouldSuspend = wallet.status === 'suspended';
      if (shortfall > 0 && Number(wallet.receivable_balance) > 0) {
        shouldSuspend = true;
      }

      const updatedW = await client.query(
        `UPDATE wallets
         SET balance = $1,
             receivable_balance = $2,
             status = CASE WHEN $3 = true THEN 'suspended' ELSE status END,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [newBalance, newReceivable, shouldSuspend, walletId]
      );

      // Update payment record
      await client.query(
        `UPDATE processed_payments
         SET status = 'refunded',
             refunded_amount = refunded_amount + $1
         WHERE payment_id = $2`,
        [refundCredits, paymentId]
      );

      await WalletCache.set(updatedW.rows[0]);

      return {
        paymentId,
        walletId,
        refundedCredits: refundCredits,
        clawedBackCredits: clawedBack,
        shortfallReceivable: shortfall,
        suspended: shouldSuspend,
        transactionId: txId,
      };
    });
  }
}
