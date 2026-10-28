import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db/connection.js';
import { WalletService } from './wallet.service.js';
import { ClockService } from './clock.service.js';

export interface RosterMemberInput {
  userId: string;
  email: string;
  role?: 'admin' | 'member';
}

export interface SyncRosterResult {
  added: number;
  removed: number;
  unchanged: number;
  totalProratedChargeMinor: number;
  members: any[];
}

export class OrgService {
  static async createOrg(name: string, ownerId: string): Promise<any> {
    return withTransaction(async (client) => {
      // Create dedicated wallet for org
      const wallet = await WalletService.getOrCreateWallet(`org_${uuidv4()}`);

      const orgId = uuidv4();
      const orgRes = await client.query(
        `INSERT INTO organizations (id, name, owner_id, wallet_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING *`,
        [orgId, name, ownerId, wallet.id]
      );

      // Add owner as org member with role = owner
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, email, role, status, joined_at)
         VALUES ($1, $2, $3, $4, 'owner', 'active', NOW())`,
        [uuidv4(), orgId, ownerId, `${ownerId}@example.com`]
      );

      return orgRes.rows[0];
    });
  }

  /**
   * Syncs roster idempotently with mid-month pro-rata calculations.
   */
  static async syncRoster(
    orgId: string,
    roster: RosterMemberInput[],
    daysInMonth = 30
  ): Promise<SyncRosterResult> {
    return withTransaction(async (client) => {
      const orgRes = await client.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
      if (orgRes.rows.length === 0) throw new Error(`Organization ${orgId} not found`);
      const org = orgRes.rows[0];

      const seatPrice = Number(org.seat_price_minor);
      const seatCredits = Number(org.seat_credits_per_month);

      const now = await ClockService.now();
      // Calculate day of the month for pro-rata (1-indexed)
      const currentDay = now.getUTCDate();
      const remainingDays = Math.max(1, daysInMonth - currentDay + 1);
      const prorationFraction = remainingDays / daysInMonth;
      const proratedSeatPrice = Math.round(seatPrice * prorationFraction);
      const proratedCredits = Math.round(seatCredits * prorationFraction);

      // Fetch existing members
      const existingRes = await client.query('SELECT * FROM org_members WHERE org_id = $1', [orgId]);
      const existingMap = new Map<string, any>();
      existingRes.rows.forEach((m) => existingMap.set(m.user_id, m));

      const inputUserIds = new Set(roster.map((r) => r.userId));
      let added = 0;
      let unchanged = 0;
      let removed = 0;
      let totalProratedChargeMinor = 0;

      // 1. Process additions or unchanged
      for (const input of roster) {
        if (existingMap.has(input.userId)) {
          unchanged++;
        } else {
          // New member added mid-month
          added++;
          totalProratedChargeMinor += proratedSeatPrice;

          // Grant prorated monthly credits to member's wallet
          const memberWallet = await WalletService.getOrCreateWallet(input.userId, orgId);
          await WalletService.grantCredits(
            memberWallet.id,
            proratedCredits,
            'subscription',
            `seat_grant:${orgId}:${input.userId}:${now.getMonth()}`,
            `seat_prorata:${orgId}:${input.userId}:${now.toISOString().substring(0, 7)}`
          );

          await client.query(
            `INSERT INTO org_members (id, org_id, user_id, email, role, status, seat_billed_until, joined_at)
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
            [
              uuidv4(),
              orgId,
              input.userId,
              input.email,
              input.role || 'member',
              new Date(now.getTime() + remainingDays * 86400 * 1000),
              now,
            ]
          );
        }
      }

      // 2. Remove members not in uploaded roster (except owners)
      for (const [userId, member] of existingMap.entries()) {
        if (!inputUserIds.has(userId) && member.role !== 'owner') {
          removed++;
          await client.query('DELETE FROM org_members WHERE id = $1', [member.id]);
        }
      }

      const allCurrent = await client.query('SELECT * FROM org_members WHERE org_id = $1', [orgId]);

      return {
        added,
        removed,
        unchanged,
        totalProratedChargeMinor,
        members: allCurrent.rows,
      };
    });
  }
}
