import { Router, Response } from 'express';
import { z } from 'zod';
import { SubscriptionService } from '../services/subscription.service.js';
import { AuthenticatedRequest, authenticateJWT, requireAdmin } from '../middleware/auth.js';
import { WalletService } from '../services/wallet.service.js';

export const subscriptionRouter = Router();

const CreateSubSchema = z.object({
  plan_id: z.string().min(1),
});

const ChangePlanSchema = z.object({
  new_plan_id: z.string().min(1),
});

/**
 * GET /v1/plans - List catalog plans
 */
subscriptionRouter.get('/plans', async (req, res) => {
  try {
    const plans = await SubscriptionService.exportCatalog();
    res.json({ plans });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /v1/plans/import - Seed, import or dry-run diff catalog
 */
subscriptionRouter.post('/plans/import', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const dryRun = req.query.dry_run === 'true';
    const jsonStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const result = await SubscriptionService.importCatalog(jsonStr, dryRun);
    res.json({ dry_run: dryRun, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /v1/subscriptions - Checkout and start subscription
 */
subscriptionRouter.post('/subscriptions', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parse = CreateSubSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const userId = req.user!.userId;
    const wallet = await WalletService.getOrCreateWallet(userId);
    const sub = await SubscriptionService.createSubscription(wallet.id, parse.data.plan_id);
    res.status(201).json({ subscription: sub });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /v1/subscriptions/:id/change-plan - Upgrade / downgrade with proration
 */
subscriptionRouter.post('/subscriptions/:id/change-plan', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parse = ChangePlanSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const result = await SubscriptionService.changePlan(req.params.id as string, parse.data.new_plan_id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
