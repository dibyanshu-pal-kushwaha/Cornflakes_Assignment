import { SubscriptionService } from '../src/services/subscription.service.js';
import { pool } from '../src/db/connection.js';
const DEFAULT_CATALOG = [
    {
        id: 'plan_starter',
        name: 'Starter Plan',
        credits_per_cycle: 500,
        price_minor: 1000, // $10.00
        currency: 'USD',
        cycle_interval_days: 30,
        active: true,
    },
    {
        id: 'plan_pro',
        name: 'Pro Creator',
        credits_per_cycle: 2500,
        price_minor: 4000, // $40.00
        currency: 'USD',
        cycle_interval_days: 30,
        active: true,
    },
    {
        id: 'plan_studio',
        name: 'Studio Enterprise',
        credits_per_cycle: 10000,
        price_minor: 15000, // $150.00
        currency: 'USD',
        cycle_interval_days: 30,
        active: true,
    },
];
async function seed() {
    console.log('[Seed] Seeding subscription plans catalog...');
    const jsonStr = JSON.stringify(DEFAULT_CATALOG, null, 2);
    // 1. Dry run diff check
    const diff = await SubscriptionService.importCatalog(jsonStr, true);
    console.log('[Seed] Dry-run diff result:', diff);
    // 2. Real import
    const result = await SubscriptionService.importCatalog(jsonStr, false);
    console.log('[Seed] Catalog successfully imported:', result);
    const allPlans = await SubscriptionService.exportCatalog();
    console.table(allPlans);
    await pool.end();
}
seed().catch((err) => {
    console.error('[Seed] Error:', err);
    process.exit(1);
});
//# sourceMappingURL=seed_plans.js.map