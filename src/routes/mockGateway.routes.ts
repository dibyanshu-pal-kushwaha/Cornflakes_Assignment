import { Router, Request, Response } from 'express';
import { MockGateway } from '../mockGateway/gateway.js';
import { ClockService } from '../services/clock.service.js';
import { WebhookService } from '../services/webhook.service.js';

export const mockGatewayRouter = Router();

/**
 * Clock endpoints (Section 5)
 */
mockGatewayRouter.get('/time', async (req: Request, res: Response): Promise<void> => {
  const current = await ClockService.now();
  const offset = await ClockService.getOffsetSeconds();
  res.json({ virtual_time: current.toISOString(), offset_seconds: offset });
});

mockGatewayRouter.post('/time/advance', async (req: Request, res: Response): Promise<void> => {
  const { seconds, days } = req.body;
  let newTime: Date;
  if (days) {
    newTime = await ClockService.advanceDays(Number(days));
  } else {
    newTime = await ClockService.advanceSeconds(Number(seconds || 3600));
  }
  res.json({ virtual_time: newTime.toISOString(), advanced: days ? `${days} days` : `${seconds} seconds` });
});

mockGatewayRouter.post('/time/reset', async (req: Request, res: Response): Promise<void> => {
  const resetTime = await ClockService.reset();
  res.json({ virtual_time: resetTime.toISOString(), status: 'clock_reset' });
});

/**
 * Gateway payment creation
 */
mockGatewayRouter.post('/gateway/pay', async (req: Request, res: Response): Promise<void> => {
  const { user_id, amount_minor, credits } = req.body;
  const result = MockGateway.createPayment(user_id || 'user_123', amount_minor || 1000, credits);

  const chaos = MockGateway.getChaos();
  if (chaos.dropWebhooks) {
    res.json({ status: 'payment_settled_at_gateway_but_webhook_dropped', ...result });
    return;
  }

  // Ingest webhook directly or via http
  const rawBody = JSON.stringify(result.payload);
  const ingestRes = await WebhookService.ingest(rawBody, result.signature);

  // If chaos duplication is enabled
  if (chaos.duplicateWebhooks) {
    for (let i = 0; i < (chaos.duplicateCount || 1); i++) {
      await WebhookService.ingest(rawBody, result.signature);
    }
  }

  res.json({ status: 'payment_settled', gateway: result, intake: ingestRes });
});

/**
 * Gateway refund creation
 */
mockGatewayRouter.post('/gateway/refund', async (req: Request, res: Response): Promise<void> => {
  const { payment_id, credits } = req.body;
  const result = MockGateway.createRefund(payment_id, credits);

  const rawBody = JSON.stringify(result.payload);
  const ingestRes = await WebhookService.ingest(rawBody, result.signature);

  res.json({ status: 'refund_created', gateway: result, intake: ingestRes });
});

/**
 * Gateway settlements report
 */
mockGatewayRouter.get('/gateway/reports/settled-payments', (req: Request, res: Response): void => {
  const report = MockGateway.getSettledPaymentsReport();
  res.json({ report });
});

/**
 * Gateway chaos switch
 */
mockGatewayRouter.post('/gateway/chaos', (req: Request, res: Response): void => {
  MockGateway.setChaos(req.body);
  res.json({ current_chaos: MockGateway.getChaos() });
});
