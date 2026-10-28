import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WebhookService } from '../src/services/webhook.service.js';
import { OutboxWorker } from '../src/services/outbox.worker.js';
import { MockGateway } from '../mockGateway/gateway.js';
import { WalletService } from '../src/services/wallet.service.js';
import { query, pool } from '../src/db/connection.js';
describe('Webhook Processing Traps (T1, T2, T3)', () => {
    beforeAll(async () => {
        await migrate();
    });
    afterAll(async () => {
        await pool.end();
    });
    it('T1: Same webhook delivered 5 times concurrently results in exactly 1 credit and 1 ledger entry', async () => {
        const userId = `t1_test_${Date.now()}`;
        const payment = MockGateway.createPayment(userId, 5000, 500);
        const rawBody = JSON.stringify(payment.payload);
        // 5 concurrent ingestions
        const ingestResults = await Promise.all(Array.from({ length: 5 }).map(() => WebhookService.ingest(rawBody, payment.signature)));
        // One accepted, others duplicate_event
        const accepted = ingestResults.filter((r) => r.status === 'accepted');
        expect(accepted.length).toBe(1);
        // Drain outbox
        await OutboxWorker.processBatch();
        const wallet = await WalletService.getOrCreateWallet(userId);
        expect(Number(wallet.balance)).toBe(500);
        const txs = await query('SELECT COUNT(*) FROM ledger_transactions WHERE reference_id = $1', [payment.payment_id]);
        expect(Number(txs.rows[0].count)).toBe(1);
    });
    it('T2: Two different events for one payment result in exactly one credit grant', async () => {
        const userId = `t2_test_${Date.now()}`;
        const paymentId = `pay_t2_${Date.now()}`;
        // Event A: payment.succeeded
        const eventA = {
            event_id: `evt_a_${Date.now()}`,
            event_type: 'payment.succeeded',
            payment_id: paymentId,
            user_id: userId,
            amount_minor: 3000,
            credits_granted: 300,
            currency: 'USD',
            created_at: Math.floor(Date.now() / 1000),
        };
        const bodyA = JSON.stringify(eventA);
        const sigA = MockGateway.signPayload(bodyA);
        // Event B: charge.settled for the SAME payment_id with different event_id
        const eventB = {
            event_id: `evt_b_${Date.now()}`,
            event_type: 'charge.settled',
            payment_id: paymentId,
            user_id: userId,
            amount_minor: 3000,
            credits_granted: 300,
            currency: 'USD',
            created_at: Math.floor(Date.now() / 1000),
        };
        const bodyB = JSON.stringify(eventB);
        const sigB = MockGateway.signPayload(bodyB);
        await WebhookService.ingest(bodyA, sigA);
        await OutboxWorker.processBatch();
        // Now ingest Event B
        const resB = await WebhookService.ingest(bodyB, sigB);
        expect(resB.status).toBe('duplicate_payment');
        await OutboxWorker.processBatch();
        const wallet = await WalletService.getOrCreateWallet(userId);
        expect(Number(wallet.balance)).toBe(300); // Not 600!
    });
    it('T3: Refund event arrives BEFORE payment event -> parked, then applied correctly after payment', async () => {
        const userId = `t3_test_${Date.now()}`;
        const paymentId = `pay_t3_${Date.now()}`;
        // 1. Send Refund FIRST (payment not yet known!)
        const refundPayload = {
            event_id: `evt_ref_${Date.now()}`,
            event_type: 'charge.refunded',
            payment_id: paymentId,
            amount_minor: 2000,
            credits_granted: 200,
            currency: 'USD',
            created_at: Math.floor(Date.now() / 1000),
        };
        const refundBody = JSON.stringify(refundPayload);
        const refundSig = MockGateway.signPayload(refundBody);
        await WebhookService.ingest(refundBody, refundSig);
        // Process outbox -> refund should be parked waiting for payment
        await OutboxWorker.processBatch();
        const parkedCheck = await query("SELECT status, park_reason FROM webhook_events WHERE event_id = $1", [refundPayload.event_id]);
        expect(parkedCheck.rows[0].status).toBe('parked');
        expect(parkedCheck.rows[0].park_reason).toBe(`waiting_for_payment:${paymentId}`);
        // 2. Now the payment event arrives!
        const paymentPayload = {
            event_id: `evt_pay_${Date.now()}`,
            event_type: 'payment.succeeded',
            payment_id: paymentId,
            user_id: userId,
            amount_minor: 2000,
            credits_granted: 200,
            currency: 'USD',
            created_at: Math.floor(Date.now() / 1000),
        };
        const paymentBody = JSON.stringify(paymentPayload);
        const paymentSig = MockGateway.signPayload(paymentBody);
        await WebhookService.ingest(paymentBody, paymentSig);
        // Process outbox -> payment processes and automatically unparks refund
        await OutboxWorker.processBatch();
        // Now process the unparked refund
        await OutboxWorker.processBatch();
        const finalRefundCheck = await query("SELECT status FROM webhook_events WHERE event_id = $1", [refundPayload.event_id]);
        expect(finalRefundCheck.rows[0].status).toBe('completed');
        // Wallet balance should be 0 because 200 was granted and 200 was refunded!
        const wallet = await WalletService.getOrCreateWallet(userId);
        expect(Number(wallet.balance)).toBe(0);
    });
});
//# sourceMappingURL=t1_t2_t3_webhooks.test.js.map