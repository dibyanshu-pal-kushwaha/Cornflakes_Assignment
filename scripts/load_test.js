import { OrgService } from '../src/services/org.service.js';
import { WebhookService } from '../src/services/webhook.service.js';
import { OutboxWorker } from '../src/services/outbox.worker.js';
import { MockGateway } from '../mockGateway/gateway.js';
import { pool } from '../src/db/connection.js';
async function runLoadTests() {
    console.log('================================================================');
    console.log('            CORNFLAKES MEDIA - HIGH CONCURRENCY LOAD TEST       ');
    console.log('================================================================\n');
    // 1. Webhook Storm (100 concurrent webhook arrivals)
    console.log('[LOAD] 1. Simulating Webhook Storm (100 concurrent payment webhooks)...');
    const stormStart = Date.now();
    const stormPayloads = Array.from({ length: 100 }).map((_, i) => MockGateway.createPayment(`storm_user_${i}`, 1000, 100));
    const stormIngest = await Promise.all(stormPayloads.map((p) => WebhookService.ingest(JSON.stringify(p.payload), p.signature)));
    const stormTime = Date.now() - stormStart;
    console.log(`--> 100 webhooks ingested in ${stormTime}ms (${(100 / (stormTime / 1000)).toFixed(1)} req/sec)`);
    // Drain outbox in batches
    console.log('[LOAD] Draining outbox...');
    let totalProcessed = 0;
    while (true) {
        const batch = await OutboxWorker.processBatch(50);
        totalProcessed += batch.processed;
        if (batch.processed === 0)
            break;
    }
    console.log(`--> Processed ${totalProcessed} events from outbox.`);
    // 2. Large Roster Sync (5,000 members)
    console.log('\n[LOAD] 2. Generating & Uploading Roster with 5,000 institutional members...');
    const org = await OrgService.createOrg('State University of Technology', 'owner_univ_dean');
    const roster = [];
    for (let i = 1; i <= 5000; i++) {
        roster.push({
            userId: `univ_student_${i}`,
            email: `student_${i}@university.edu`,
            role: 'member',
        });
    }
    const rosterStart = Date.now();
    const syncResult = await OrgService.syncRoster(org.id, roster);
    const rosterTime = Date.now() - rosterStart;
    console.log(`--> 5,000 seats synced in ${rosterTime}ms!`);
    console.log(`    Added: ${syncResult.added}`);
    console.log(`    Total Prorated Minor Charges: $${(syncResult.totalProratedChargeMinor / 100).toFixed(2)}`);
    console.log('\n[LOAD] All load test scenarios completed successfully.');
    await pool.end();
}
runLoadTests().catch((err) => {
    console.error('[Load] Error:', err);
    process.exit(1);
});
//# sourceMappingURL=load_test.js.map