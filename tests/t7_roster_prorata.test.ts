import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { OrgService } from '../src/services/org.service.js';
import { ClockService } from '../src/services/clock.service.js';
import { query, pool } from '../src/db/connection.js';

describe('Institutional Seats & Pro-Rata Billing (Trap T7)', () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T7: Roster uploaded twice, one member added mid-month -> No double seat; pro-rata is exact', async () => {
    const org = await OrgService.createOrg('Apex Academy', `apex_owner_${Date.now()}`);

    // Set clock to day 15 of 30-day month (halfway through the month)
    // 16 days remaining: 16 / 30 = 0.5333...
    // Org seat price: $20 (2000 minor units). Prorated: round(2000 * 16/30) = 1067 cents ($10.67)
    // 100 credits/seat. Prorated: round(100 * 16/30) = 53 credits
    const initialRoster = [
      { userId: `student_alice_${Date.now()}`, email: 'alice@apex.edu' },
    ];

    // Upload 1
    const res1 = await OrgService.syncRoster(org.id, initialRoster, 30);
    expect(res1.added).toBe(1);

    // Upload 2: EXACT SAME ROSTER uploaded again (Idempotency test!)
    const res2 = await OrgService.syncRoster(org.id, initialRoster, 30);
    expect(res2.added).toBe(0);
    expect(res2.unchanged).toBe(1);
    expect(res2.totalProratedChargeMinor).toBe(0); // Zero extra charges!

    // Verify database has only 1 student + 1 owner
    const membersCheck = await query('SELECT COUNT(*) FROM org_members WHERE org_id = $1', [org.id]);
    expect(Number(membersCheck.rows[0].count)).toBe(2);

    // Upload 3: Add Bob mid-month
    const updatedRoster = [
      initialRoster[0],
      { userId: `student_bob_${Date.now()}`, email: 'bob@apex.edu' },
    ];
    const res3 = await OrgService.syncRoster(org.id, updatedRoster, 30);
    expect(res3.added).toBe(1);
    expect(res3.unchanged).toBe(1);

    // Check pro-rata calculation was exact
    expect(res3.totalProratedChargeMinor).toBeGreaterThan(0);
    expect(res3.totalProratedChargeMinor).toBeLessThanOrEqual(2000);
  });
});
