import pg from 'pg';
import { query, withTransaction } from '../db/connection.js';
import { WalletService } from './wallet.service.js';
import { RefundService } from './refund.service.js';
import { WebhookRecord } from '../types/index.js';

let isWorkerPaused = false;

export class OutboxWorker {
  static setPaused(paused: boolean): void {
    isWorkerPaused = paused;
    console.log(`[OutboxWorker] Worker paused status: ${paused}`);
  }

  static isPaused(): boolean {
    return isWorkerPaused;
  }

  /**
   * Processes the next batch of outbox webhooks.
   */
  static async processBatch(limit = 10): Promise<{ processed: number; parked: number; failed: number }> {
    if (isWorkerPaused) {
      return { processed: 0, parked: 0, failed: 0 };
    }

    // Select pending events, and parked events whose prerequisite is now ready
    const eventsRes = await query<WebhookRecord>(
      `SELECT * FROM webhook_events
       WHERE status = 'pending'
          OR (status = 'parked' AND park_reason LIKE 'waiting_for_payment:%' 
              AND substring(park_reason from 'waiting_for_payment:(.*)') IN (SELECT payment_id FROM processed_payments))
       ORDER BY received_at ASC
       LIMIT $1`,
      [limit]
    );

    let processed = 0;
    let parked = 0;
    let failed = 0;

    for (const event of eventsRes.rows) {
      try {
        const result = await this.processSingleEvent(event);
        if (result === 'completed') processed++;
        else if (result === 'parked') parked++;
      } catch (err: any) {
        failed++;
        console.error(`[OutboxWorker] Error processing event ${event.event_id}:`, err.message);
        await this.handleFailure(event, err.message);
      }
    }

    return { processed, parked, failed };
  }

  private static async processSingleEvent(event: WebhookRecord): Promise<'completed' | 'parked'> {
    const { event_type, payment_id, payload } = event;

    if (event_type === 'payment.succeeded' || event_type === 'charge.settled') {
      return withTransaction<'completed' | 'parked'>(async (client) => {
        // Double check payment deduplication under lock
        const existingPayment = await client.query(
          'SELECT payment_id FROM processed_payments WHERE payment_id = $1 FOR UPDATE',
          [payment_id]
        );

        if (existingPayment.rows.length === 0) {
          const userId = payload.user_id || 'anonymous_user';
          const wallet = await WalletService.getOrCreateWallet(userId);
          const credits = payload.credits_granted || Math.floor((payload.amount_minor || 1000) / 10);
          const source = payload.source_type || 'purchased';

          await WalletService.grantCredits(
            wallet.id,
            credits,
            source,
            payment_id,
            `event:${event.event_id}`
          );

          await client.query(
            `INSERT INTO processed_payments (payment_id, first_event_id, amount, currency, wallet_id, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'settled', NOW())`,
            [payment_id, event.event_id, payload.amount_minor || 0, payload.currency || 'USD', wallet.id]
          );

          // Create an invoice record
          const subtotal = payload.amount_minor || 1000;
          const tax = Math.round(subtotal * 0.1); // 10% tax
          const total = subtotal + tax;
          await client.query(
            `INSERT INTO invoices (payment_id, wallet_id, subtotal_minor, tax_minor, total_minor, currency, line_items, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [
              payment_id,
              wallet.id,
              subtotal,
              tax,
              total,
              payload.currency || 'USD',
              JSON.stringify([{ item: `${credits} Credits Pack`, price_minor: subtotal, tax_minor: tax }]),
            ]
          );
        }

        // Mark this event completed
        await client.query(
          `UPDATE webhook_events
           SET status = 'completed', processed_at = NOW()
           WHERE id = $1`,
          [event.id]
        );

        // Unpark any events waiting for this payment
        await client.query(
          `UPDATE webhook_events
           SET status = 'pending', park_reason = NULL
           WHERE status = 'parked' AND park_reason = $1`,
          [`waiting_for_payment:${payment_id}`]
        );

        return 'completed';
      });
    }

    if (event_type === 'charge.refunded' || event_type === 'payment.refunded') {
      // Check if original payment exists
      const pRes = await query('SELECT payment_id FROM processed_payments WHERE payment_id = $1', [payment_id]);
      if (pRes.rows.length === 0) {
        // Out of order: Refund arrived BEFORE payment! Park it.
        await query(
          `UPDATE webhook_events
           SET status = 'parked', park_reason = $1
           WHERE id = $2`,
          [`waiting_for_payment:${payment_id}`, event.id]
        );
        return 'parked';
      }

      // Payment exists: Process refund
      const refundCredits = payload.credits_granted || Math.floor((payload.amount_minor || 1000) / 10);
      await RefundService.processRefund(payment_id, refundCredits, event.event_id);

      await query(
        `UPDATE webhook_events
         SET status = 'completed', processed_at = NOW()
         WHERE id = $1`,
        [event.id]
      );
      return 'completed';
    }

    // Default: Mark complete
    await query(`UPDATE webhook_events SET status = 'completed', processed_at = NOW() WHERE id = $1`, [event.id]);
    return 'completed';
  }

  private static async handleFailure(event: WebhookRecord, errorMsg: string): Promise<void> {
    const newRetry = event.retry_count + 1;
    const isDeadLetter = newRetry >= 5;
    const status = isDeadLetter ? 'dead_letter' : 'pending';

    await query(
      `UPDATE webhook_events
       SET status = $1, retry_count = $2, last_error = $3
       WHERE id = $4`,
      [status, newRetry, errorMsg, event.id]
    );
  }

  /**
   * Retries a dead-letter webhook event.
   */
  static async retryDeadLetter(eventId: string): Promise<boolean> {
    const res = await query(
      `UPDATE webhook_events
       SET status = 'pending', retry_count = 0, last_error = NULL
       WHERE event_id = $1 AND status = 'dead_letter'`,
      [eventId]
    );
    return (res.rowCount ?? 0) > 0;
  }
}
