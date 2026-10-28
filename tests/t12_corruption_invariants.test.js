import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WalletService } from '../src/services/wallet.service.js';
import { LedgerInvariants } from '../src/ledger/invariants.js';
import { ReconcilerService } from '../src/services/reconciler.service.js';
import { pool } from '../src/db/connection.js';
describe('Hand Corruption Detection & Reconciler (Trap T12)', () => {
    beforeAll(async () => {
        await migrate();
    });
    afterAll(async () => {
        await pool.end();
    });
    it('T12: Hand corruption of a wallet row is immediately caught, naming the wallet and exact difference', async () => {
        const userId = `t12_victim_${Date.now()}`;
        const wallet = await WalletService.getOrCreateWallet(userId);
        await WalletService.grantCredits(wallet.id, 500, 'purchased', 't12_grant');
        // Baseline: clean verification
        const cleanReport = await LedgerInvariants.verifyAll();
        expect(cleanReport.allPassed).toBe(true);
        // Corrupt one wallet row by hand (+777 unauthorized credits)
        await LedgerInvariants.injectWalletCorruption(wallet.id, 777);
        // 1. LedgerInvariants verification check
        const corruptReport = await LedgerInvariants.verifyAll();
        expect(corruptReport.allPassed).toBe(false);
        const walletCheck = corruptReport.results.find((r) => r.name === 'Wallet balance matches sum of ledger entries');
        expect(walletCheck?.passed).toBe(false);
        const discrepancy = walletCheck?.discrepancies?.find((d) => d.wallet_id === wallet.id);
        expect(discrepancy).toBeDefined();
        expect(discrepancy.difference).toBe(777); // Exactly names the discrepancy!
        // 2. Reconciler check: catches and alerts the corruption
        const reconReport = await ReconcilerService.reconcile([]);
        const reconDiff = reconReport.differences.find((d) => d.identifier === wallet.id);
        expect(reconDiff).toBeDefined();
        expect(reconDiff?.type).toBe('wallet_balance_mismatch');
        // 3. Repair wallet back to ledger truth
        const repairedBal = await LedgerInvariants.repairWalletFromLedger(wallet.id);
        expect(repairedBal).toBe(500);
        const restoredReport = await LedgerInvariants.verifyAll();
        expect(restoredReport.allPassed).toBe(true);
    });
});
//# sourceMappingURL=t12_corruption_invariants.test.js.map