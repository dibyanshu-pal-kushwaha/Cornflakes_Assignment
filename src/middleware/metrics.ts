import client from 'prom-client';
import { query } from '../db/connection.js';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const webhookLagGauge = new client.Gauge({
  name: 'webhook_lag_seconds',
  help: 'Difference between webhook timestamp and processed_at in seconds',
  registers: [register],
});

export const outboxDepthGauge = new client.Gauge({
  name: 'outbox_depth',
  help: 'Current count of pending webhook events in outbox',
  registers: [register],
});

export const deadLettersGauge = new client.Gauge({
  name: 'dead_letters_count',
  help: 'Total count of dead-lettered webhook events',
  registers: [register],
});

export const reconciliationDifferencesGauge = new client.Gauge({
  name: 'reconciliation_differences',
  help: 'Number of discrepancies identified in last reconciliation run',
  registers: [register],
});

export const reserveSuccessGauge = new client.Gauge({
  name: 'reserve_success_rate',
  help: 'Ratio of successful reservations over attempted reservations',
  registers: [register],
});

let totalReserves = 0;
let successfulReserves = 0;

export function recordReserveAttempt(success: boolean): void {
  totalReserves++;
  if (success) successfulReserves++;
  const rate = totalReserves > 0 ? successfulReserves / totalReserves : 1.0;
  reserveSuccessGauge.set(rate);
}

export async function updateSystemMetrics(): Promise<void> {
  try {
    const depthRes = await query("SELECT COUNT(*) FROM webhook_events WHERE status = 'pending'");
    outboxDepthGauge.set(Number(depthRes.rows[0].count));

    const deadRes = await query("SELECT COUNT(*) FROM webhook_events WHERE status = 'dead_letter'");
    deadLettersGauge.set(Number(deadRes.rows[0].count));

    const lagRes = await query(
      `SELECT EXTRACT(EPOCH FROM (processed_at - received_at)) AS lag 
       FROM webhook_events 
       WHERE processed_at IS NOT NULL 
       ORDER BY processed_at DESC 
       LIMIT 1`
    );
    if (lagRes.rows.length > 0 && lagRes.rows[0].lag !== null) {
      webhookLagGauge.set(Math.max(0, Number(lagRes.rows[0].lag)));
    }
  } catch {}
}
