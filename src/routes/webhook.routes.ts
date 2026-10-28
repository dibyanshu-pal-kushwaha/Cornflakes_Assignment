import { Router, Request, Response } from 'express';
import { WebhookService } from '../services/webhook.service.js';
import { webhookRateLimiter } from '../middleware/rateLimiter.js';

export const webhookRouter = Router();

/**
 * POST /v1/webhooks/gateway - Webhook intake endpoint
 * Raw body used for HMAC verification; fast outbox queuing.
 */
webhookRouter.post('/gateway', webhookRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const signatureHeader = (req.headers['x-signature'] || req.headers['stripe-signature']) as string | undefined;
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);

  try {
    const result = await WebhookService.ingest(rawBody, signatureHeader);
    const statusCode = result.status === 'accepted' ? 202 : 200;
    res.status(statusCode).json(result);
  } catch (err: any) {
    if (err.name === 'WebhookVerificationError') {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err.name === 'StaleTimestampError') {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});
