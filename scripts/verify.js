import { LedgerInvariants } from '../src/ledger/invariants.js';
import { WalletService } from '../src/services/wallet.service.js';
import { pool } from '../src/db/connection.js';
async function run() {
    console.log('================================================================');
    console.log('       CORNFLAKES MEDIA - LEDGER INVARIANTS VERIFICATION       ');
    console.log('================================================================\n');
    const args = process.argv.slice(2);
    const demonstrateCorruption = args.includes('--demo-corruption');
    if (demonstrateCorruption) {
        console.log('[DEMO] 1. Creating a test wallet and granting 500 credits...');
        const wallet = await WalletService.getOrCreateWallet('corruption_test_user');
        await WalletService.grantCredits(wallet.id, 500, 'purchased', 'corrupt_test_grant');
        console.log('[DEMO] 2. Injecting direct unauthorized balance corruption (+250 credits by hand)...');
        await LedgerInvariants.injectWalletCorruption(wallet.id, 250);
        console.log('[DEMO] 3. Running invariant verification against corrupted database:');
        const corruptReport = await LedgerInvariants.verifyAll();
        console.log(JSON.stringify(corruptReport, null, 2));
        if (!corruptReport.allPassed) {
            console.log('\n--> SUCCESS: Invariant job accurately caught the injected corruption!');
            console.log(`--> Mismatched wallet identified: ${wallet.id}`);
        }
        console.log('\n[DEMO] 4. Repairing wallet from immutable ledger entries...');
        const newBal = await LedgerInvariants.repairWalletFromLedger(wallet.id);
        console.log(`--> Repaired wallet balance back to ledger truth: ${newBal}`);
        console.log('\n----------------------------------------------------------------\n');
    }
    const report = await LedgerInvariants.verifyAll();
    console.log(`Verification Timestamp: ${report.timestamp}`);
    console.log(`Overall Health: ${report.allPassed ? 'ALL INVARIANTS PASSED' : 'INVARIANTS FAILED'}\n`);
    console.table(report.results.map((r) => ({
        Invariant: r.name,
        Status: r.passed ? 'PASS' : 'FAIL',
        Details: r.details || 'OK',
    })));
    if (!report.allPassed) {
        console.error('\nDiscrepancies identified:');
        report.results
            .filter((r) => !r.passed)
            .forEach((r) => {
            console.error(`- ${r.name}: ${JSON.stringify(r.discrepancies)}`);
        });
        process.exit(1);
    }
    console.log('\nDatabase ledger integrity is mathematically proven and balanced.');
    await pool.end();
    process.exit(0);
}
run().catch((err) => {
    console.error('[Verify] Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=verify.js.map