import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { LedgerInvariants } from '../ledger/invariants.js';
import { ReconcilerService } from '../services/reconciler.service.js';
import { MockGateway } from '../mockGateway/gateway.js';
import { SchedulerService } from '../services/scheduler.service.js';
import { OutboxWorker } from '../services/outbox.worker.js';
import { reconciliationDifferencesGauge } from '../middleware/metrics.js';

export const adminRouter = Router();

/**
 * Search ledger entries
 */
adminRouter.get('/admin/ledger/search', async (req: Request, res: Response): Promise<void> => {
  try {
    const q = (req.query.q as string) || '';
    const sql = `
      SELECT le.*, lt.type, lt.description, lt.reference_id
      FROM ledger_entries le
      JOIN ledger_transactions lt ON le.transaction_id = lt.id
      WHERE le.account_id ILIKE $1 
         OR lt.reference_id ILIKE $1 
         OR le.id::text ILIKE $1
         OR lt.id::text ILIKE $1
      ORDER BY le.created_at DESC
      LIMIT 100;
    `;
    const entries = await query(sql, [`%${q}%`]);
    res.json({ entries: entries.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * List dead letters
 */
adminRouter.get('/admin/dead-letters', async (req: Request, res: Response): Promise<void> => {
  try {
    const deadLetters = await query(
      `SELECT id, event_id, payment_id, event_type, retry_count, last_error, received_at
       FROM webhook_events
       WHERE status = 'dead_letter'
       ORDER BY received_at DESC`
    );
    res.json({ dead_letters: deadLetters.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Retry dead letter
 */
adminRouter.post('/admin/dead-letters/:id/retry', async (req: Request, res: Response): Promise<void> => {
  try {
    const eventId = req.params.id as string;
    const ok = await OutboxWorker.retryDeadLetter(eventId);
    if (!ok) {
      res.status(404).json({ error: 'Dead letter event not found or not in dead_letter status' });
      return;
    }
    // Immediately process a batch
    await OutboxWorker.processBatch();
    res.json({ status: 're-queued', event_id: eventId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Run make verify programmatically
 */
adminRouter.get('/admin/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const report = await LedgerInvariants.verifyAll();
    res.status(report.allPassed ? 200 : 409).json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Run reconciler against gateway ground truth
 */
adminRouter.post('/admin/reconcile', async (req: Request, res: Response): Promise<void> => {
  try {
    const gatewayReport = MockGateway.getSettledPaymentsReport();
    const result = await ReconcilerService.reconcile(gatewayReport);
    reconciliationDifferencesGauge.set(result.differences.length);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger sweeps
 */
adminRouter.post('/admin/sweeps/hourly', async (req: Request, res: Response): Promise<void> => {
  try {
    const report = MockGateway.getSettledPaymentsReport();
    const result = await SchedulerService.runHourlyGrantSweep(report as any);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/admin/sweeps/expiry', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await SchedulerService.runCreditExpirySweep();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Chaos controls
 */
adminRouter.post('/admin/chaos/pause-worker', (req: Request, res: Response): void => {
  const pause = req.body.paused !== false;
  OutboxWorker.setPaused(pause);
  res.json({ worker_paused: pause });
});

adminRouter.post('/admin/chaos/corrupt-wallet', async (req: Request, res: Response): Promise<void> => {
  try {
    const { wallet_id, delta } = req.body;
    await LedgerInvariants.injectWalletCorruption(wallet_id, delta || 9999);
    res.json({ message: 'Corruption injected successfully', wallet_id, delta: delta || 9999 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/admin/chaos/repair-wallet', async (req: Request, res: Response): Promise<void> => {
  try {
    const { wallet_id } = req.body;
    const newBal = await LedgerInvariants.repairWalletFromLedger(wallet_id);
    res.json({ message: 'Wallet repaired from ledger entries', wallet_id, new_balance: newBal });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
