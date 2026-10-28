import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WalletService } from '../src/services/wallet.service.js';
import { RefundService } from '../src/services/refund.service.js';
import { query, pool } from '../src/db/connection.js';
describe('Refunds, Clawback & Accounts Receivable (Trap T8)', () => {
    beforeAll(async () => {
        await migrate();
    });
    afterAll(async () => {
        await pool.end();
    });
    it('T8: Refund after half the credits were spent -> Never silently negative; shortfall receivable recorded', async () => {
        const userId = `t8_user_${Date.now()}`;
        const wallet = await WalletService.getOrCreateWallet(userId);
        const paymentId = `pay_t8_${Date.now()}`;
        // 1. Grant 100 credits from payment
        await WalletService.grantCredits(wallet.id, 100, 'purchased', paymentId, `pay_t8_seed`);
        await query(`INSERT INTO processed_payments (payment_id, first_event_id, amount, currency, wallet_id, status, created_at)
       VALUES ($1, $2, 1000, 'USD', $3, 'settled', NOW())`, [paymentId, `evt_t8_seed`, wallet.id]);
        // 2. Spend half the credits (50 credits reserved & committed)
        const reservation = await WalletService.reserve(wallet.id, 50, `t8_gen_res_${Date.now()}`);
        await WalletService.commit(reservation.id, `t8_commit_${Date.now()}`);
        const walletAfterSpend = await WalletService.getWallet(wallet.id);
        expect(Number(walletAfterSpend.balance)).toBe(50); // 50 credits remaining
        // 3. Customer requests FULL refund of 100 credits!
        const refundResult = await RefundService.processRefund(paymentId, 100, `evt_t8_refund`);
        // Verify policy applied:
        // Available 50 credits clawed back
        expect(refundResult.clawedBackCredits).toBe(50);
        // 50 credits shortfall recorded as receivable
        expect(refundResult.shortfallReceivable).toBe(50);
        const finalWallet = await WalletService.getWallet(wallet.id);
        expect(Number(finalWallet.balance)).toBe(0); // Balance is 0, NEVER silently negative!
        expect(Number(finalWallet.receivable_balance)).toBe(50); // Receivable tracked
    });
});
//# sourceMappingURL=t8_refunds.test.js.map