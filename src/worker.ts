import dotenv from 'dotenv';
import { OutboxWorker } from './services/outbox.worker.js';
import { SchedulerService } from './services/scheduler.service.js';
import { migrate } from './db/migrate.js';

dotenv.config();

console.log('[Worker] Starting Outbox Worker & Background Sweep Engine...');

let isRunning = true;

async function runWorkerLoop() {
  await migrate().catch((e) => console.warn('[Worker] Migration warning:', e.message));

  let lastHourlySweep = 0;
  let lastExpirySweep = 0;
  let lastDunningSweep = 0;

  while (isRunning) {
    try {
      // 1. Process outbox batch (every 500ms)
      const res = await OutboxWorker.processBatch(20);
      if (res.processed > 0 || res.failed > 0) {
        console.log(`[Worker] Outbox batch: processed=${res.processed}, parked=${res.parked}, failed=${res.failed}`);
      }

      const now = Date.now();

      // 2. Hourly sweep (run every 60 seconds in worker)
      if (now - lastHourlySweep > 60000) {
        await SchedulerService.runHourlyGrantSweep();
        lastHourlySweep = now;
      }

      // 3. Expiry sweep (run every 120 seconds in worker)
      if (now - lastExpirySweep > 120000) {
        await SchedulerService.runCreditExpirySweep();
        lastExpirySweep = now;
      }

      // 4. Daily dunning sweep (run every 300 seconds in worker)
      if (now - lastDunningSweep > 300000) {
        await SchedulerService.runDailyDunningSweep();
        lastDunningSweep = now;
      }
    } catch (err: any) {
      console.error('[Worker] Loop error:', err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

process.on('SIGTERM', () => {
  console.log('[Worker] SIGTERM received, shutting down gracefully...');
  isRunning = false;
});

process.on('SIGINT', () => {
  console.log('[Worker] SIGINT received, shutting down gracefully...');
  isRunning = false;
});

runWorkerLoop();
