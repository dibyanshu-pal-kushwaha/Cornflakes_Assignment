import crypto from 'crypto';
import { query, withTransaction } from '../db/connection.js';
import { ClockService } from './clock.service.js';
import { WebhookEventPayload } from '../types/index.js';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export class StaleTimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleTimestampError';
  }
}

export class WebhookService {
  private static getSecret(): string {
    return process.env.WEBHOOK_SECRET || 'whsec_mock_gateway_shared_secret_key_8829';
  }

  /**
   * Verifies the HMAC-SHA256 signature using raw request body.
   */
  static verifySignature(rawBody: string, signatureHeader?: string): boolean {
    if (!signatureHeader) return false;

    const secret = this.getSecret();
    const parts = signatureHeader.split(',');
    let timestamp = '';
    let signature = '';

    for (const part of parts) {
      const [k, v] = part.trim().split('=');
      if (k === 't') timestamp = v;
      if (k === 'v1') signature = v;
    }

    const hashTarget = timestamp ? `${timestamp}.${rawBody}` : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(hashTarget).digest('hex');
    const provided = signature || signatureHeader;

    if (provided.length !== expected.length) return false;

    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }

  /**
   * Validates timestamp freshness (within 5 minutes).
   */
  static async validateTimestamp(timestampSeconds?: number): Promise<void> {
    if (!timestampSeconds) return;
    const now = await ClockService.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const diff = Math.abs(nowSeconds - timestampSeconds);

    if (diff > 300) { // 5 minutes tolerance
      throw new StaleTimestampError(`Webhook timestamp is stale. Diff: ${diff}s`);
    }
  }

  /**
   * Ingests a webhook into the outbox.
   * Atomic, deduplicated, and returns immediately.
   */
  static async ingest(
    rawBody: string,
    signatureHeader?: string
  ): Promise<{ status: string; event_id: string; message: string }> {
    // 1. Signature verification
    if (!this.verifySignature(rawBody, signatureHeader)) {
      throw new WebhookVerificationError('Invalid webhook signature');
    }

    let payload: WebhookEventPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error('Malformed JSON payload');
    }

    // 2. Reject stale timestamps
    await this.validateTimestamp(payload.created_at);

    const eventId = payload.event_id;
    const paymentId = payload.payment_id;
    const eventType = payload.event_type;

    try {
      return await withTransaction(async (client) => {
        // 3. Deduplication check by event_id
        const existing = await client.query(
          'SELECT id, status FROM webhook_events WHERE event_id = $1',
          [eventId]
        );
        if (existing.rows.length > 0) {
          return {
            status: 'duplicate_event',
            event_id: eventId,
            message: 'Webhook event already ingested',
          };
        }

        // 4. Deduplication check by payment_id for credit grants
        if (eventType === 'payment.succeeded' || eventType === 'charge.settled') {
          const settled = await client.query(
            'SELECT payment_id FROM processed_payments WHERE payment_id = $1',
            [paymentId]
          );
          if (settled.rows.length > 0) {
            await client.query(
              `INSERT INTO webhook_events (event_id, payment_id, event_type, payload, raw_body, signature, status, processed_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW())
               ON CONFLICT (event_id) DO NOTHING`,
              [eventId, paymentId, eventType, payload, rawBody, signatureHeader || '']
            );
            return {
              status: 'duplicate_payment',
              event_id: eventId,
              message: 'Payment already processed and credited',
            };
          }
        }

        // 5. Insert into outbox as pending with conflict protection
        const ins = await client.query(
          `INSERT INTO webhook_events (event_id, payment_id, event_type, payload, raw_body, signature, status, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
           ON CONFLICT (event_id) DO NOTHING
           RETURNING id`,
          [eventId, paymentId, eventType, payload, rawBody, signatureHeader || '']
        );

        if (ins.rows.length === 0) {
          return {
            status: 'duplicate_event',
            event_id: eventId,
            message: 'Webhook event already ingested',
          };
        }

        return {
          status: 'accepted',
          event_id: eventId,
          message: 'Webhook queued for asynchronous outbox processing',
        };
      });
    } catch (err: any) {
      if (err.code === '23505') { // Unique violation
        return {
          status: 'duplicate_event',
          event_id: eventId,
          message: 'Webhook event already ingested',
        };
      }
      throw err;
    }
  }
}
