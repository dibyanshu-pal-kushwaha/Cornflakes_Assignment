import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, withTransaction } from '../db/connection.js';
import { WalletService } from './wallet.service.js';
import { ClockService } from './clock.service.js';
import { PlanCatalogItem } from '../types/index.js';

export const PlanSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  credits_per_cycle: z.number().int().positive(),
  price_minor: z.number().int().nonnegative(),
  currency: z.string().default('USD'),
  cycle_interval_days: z.number().int().positive().default(30),
  active: z.boolean().default(true),
});

export const CatalogSchema = z.array(PlanSchema);

export class SubscriptionService {
  /**
   * Imports or diffs a plans catalog from JSON.
   */
  static async importCatalog(jsonString: string, dryRun = false): Promise<{
    added: string[];
    updated: string[];
    unchanged: string[];
  }> {
    const parsed = CatalogSchema.parse(JSON.parse(jsonString));
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];

    for (const plan of parsed) {
      const existing = await query<PlanCatalogItem>('SELECT * FROM plans WHERE id = $1', [plan.id]);
      if (existing.rows.length === 0) {
        added.push(plan.id);
        if (!dryRun) {
          await query(
            `INSERT INTO plans (id, name, credits_per_cycle, price_minor, currency, cycle_interval_days, active, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [plan.id, plan.name, plan.credits_per_cycle, plan.price_minor, plan.currency, plan.cycle_interval_days, plan.active]
          );
        }
      } else {
        const cur = existing.rows[0];
        const isDiff =
          cur.name !== plan.name ||
          Number(cur.credits_per_cycle) !== plan.credits_per_cycle ||
          Number(cur.price_minor) !== plan.price_minor ||
          cur.currency !== plan.currency ||
          cur.cycle_interval_days !== plan.cycle_interval_days ||
          cur.active !== plan.active;

        if (isDiff) {
          updated.push(plan.id);
          if (!dryRun) {
            await query(
              `UPDATE plans 
               SET name = $1, credits_per_cycle = $2, price_minor = $3, currency = $4, cycle_interval_days = $5, active = $6
               WHERE id = $7`,
              [plan.name, plan.credits_per_cycle, plan.price_minor, plan.currency, plan.cycle_interval_days, plan.active, plan.id]
            );
          }
        } else {
          unchanged.push(plan.id);
        }
      }
    }

    return { added, updated, unchanged };
  }

  static async exportCatalog(): Promise<PlanCatalogItem[]> {
    const res = await query<PlanCatalogItem>('SELECT * FROM plans ORDER BY id ASC');
    return res.rows;
  }

  /**
   * Creates a subscription for a wallet.
   */
  static async createSubscription(walletId: string, planId: string): Promise<any> {
    const planRes = await query<PlanCatalogItem>('SELECT * FROM plans WHERE id = $1 AND active = true', [planId]);
    if (planRes.rows.length === 0) throw new Error(`Plan ${planId} not found or inactive`);
    const plan = planRes.rows[0];

    const now = await ClockService.now();
    const periodEnd = new Date(now.getTime() + plan.cycle_interval_days * 86400 * 1000);
    const subId = uuidv4();

    return withTransaction(async (client) => {
      // Grant first cycle credits
      await WalletService.grantCredits(
        walletId,
        Number(plan.credits_per_cycle),
        'subscription',
        subId,
        `sub_initial:${subId}`,
        periodEnd
      );

      const res = await client.query(
        `INSERT INTO subscriptions (id, wallet_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $6)
         RETURNING *`,
        [subId, walletId, planId, now, periodEnd, now]
      );
      return res.rows[0];
    });
  }

  /**
   * Renew subscription for a cycle (deduplicated by cycle key).
   */
  static async renewCycle(subscriptionId: string, cycleKey: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const subRes = await client.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [subscriptionId]);
      if (subRes.rows.length === 0) throw new Error(`Subscription ${subscriptionId} not found`);
      const sub = subRes.rows[0];

      if (sub.last_renewed_cycle === cycleKey) {
        return false; // Already renewed for this cycle! Exactly once.
      }

      const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [sub.plan_id]);
      const plan = planRes.rows[0];

      const now = await ClockService.now();
      const newPeriodEnd = new Date(now.getTime() + plan.cycle_interval_days * 86400 * 1000);

      // Grant cycle credits
      await WalletService.grantCredits(
        sub.wallet_id,
        Number(plan.credits_per_cycle),
        'subscription',
        subscriptionId,
        `renewal:${subscriptionId}:${cycleKey}`,
        newPeriodEnd
      );

      await client.query(
        `UPDATE subscriptions
         SET status = 'active',
             dunning_attempt = 0,
             next_dunning_at = NULL,
             current_period_start = $1,
             current_period_end = $2,
             last_renewed_cycle = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [now, newPeriodEnd, cycleKey, subscriptionId]
      );

      return true;
    });
  }

  /**
   * Dunning State Machine: handles renewal payment failure.
   */
  static async handleRenewalFailure(subscriptionId: string): Promise<string> {
    return withTransaction(async (client) => {
      const subRes = await client.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [subscriptionId]);
      if (subRes.rows.length === 0) throw new Error(`Subscription ${subscriptionId} not found`);
      const sub = subRes.rows[0];

      const now = await ClockService.now();
      const attempt = sub.dunning_attempt + 1;

      let nextStatus = sub.status;
      let nextDunningAt: Date | null = null;

      if (attempt === 1) {
        nextStatus = 'grace_period';
        nextDunningAt = new Date(now.getTime() + 1 * 86400 * 1000); // retry in 1 day
      } else if (attempt === 2) {
        nextStatus = 'grace_period';
        nextDunningAt = new Date(now.getTime() + 3 * 86400 * 1000); // retry in 3 days
      } else if (attempt === 3) {
        nextStatus = 'grace_period';
        nextDunningAt = new Date(now.getTime() + 7 * 86400 * 1000); // retry in 7 days
      } else if (attempt === 4) {
        nextStatus = 'suspended';
        nextDunningAt = new Date(now.getTime() + 14 * 86400 * 1000); // suspended for 14 days before cancellation
      } else {
        nextStatus = 'cancelled';
        nextDunningAt = null;
      }

      await client.query(
        `UPDATE subscriptions
         SET status = $1, dunning_attempt = $2, next_dunning_at = $3, updated_at = NOW()
         WHERE id = $4`,
        [nextStatus, attempt, nextDunningAt, subscriptionId]
      );

      return nextStatus;
    });
  }

  /**
   * Recovers subscription from dunning upon successful payment.
   */
  static async recoverSubscription(subscriptionId: string): Promise<void> {
    await query(
      `UPDATE subscriptions
       SET status = 'active', dunning_attempt = 0, next_dunning_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [subscriptionId]
    );
  }

  /**
   * Upgrade or downgrade with proration.
   */
  static async changePlan(
    subscriptionId: string,
    newPlanId: string
  ): Promise<{ prorationChargeMinor: number; creditsDelta: number }> {
    return withTransaction(async (client) => {
      const subRes = await client.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [subscriptionId]);
      if (subRes.rows.length === 0) throw new Error('Subscription not found');
      const sub = subRes.rows[0];

      const oldPlanRes = await client.query('SELECT * FROM plans WHERE id = $1', [sub.plan_id]);
      const newPlanRes = await client.query('SELECT * FROM plans WHERE id = $1', [newPlanId]);
      const oldPlan = oldPlanRes.rows[0];
      const newPlan = newPlanRes.rows[0];

      const now = await ClockService.now();
      const periodStart = new Date(sub.current_period_start).getTime();
      const periodEnd = new Date(sub.current_period_end).getTime();
      const totalPeriodMs = periodEnd - periodStart;
      const remainingMs = Math.max(0, periodEnd - now.getTime());
      const fractionRemaining = totalPeriodMs > 0 ? remainingMs / totalPeriodMs : 0;

      // Price proration
      const oldPriceProrated = Math.round(Number(oldPlan.price_minor) * fractionRemaining);
      const newPriceProrated = Math.round(Number(newPlan.price_minor) * fractionRemaining);
      const prorationCharge = Math.max(0, newPriceProrated - oldPriceProrated);

      // Credits delta
      const oldCreditsRemaining = Math.round(Number(oldPlan.credits_per_cycle) * fractionRemaining);
      const newCreditsAllocated = Math.round(Number(newPlan.credits_per_cycle) * fractionRemaining);
      const creditsDelta = newCreditsAllocated - oldCreditsRemaining;

      if (creditsDelta > 0) {
        await WalletService.grantCredits(
          sub.wallet_id,
          creditsDelta,
          'subscription',
          subscriptionId,
          `proration_upgrade:${subscriptionId}:${now.getTime()}`,
          new Date(sub.current_period_end)
        );
      }

      await client.query(
        `UPDATE subscriptions
         SET plan_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [newPlanId, subscriptionId]
      );

      return { prorationChargeMinor: prorationCharge, creditsDelta };
    });
  }
}
