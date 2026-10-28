import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { walletRouter } from './routes/wallet.routes.js';
import { webhookRouter } from './routes/webhook.routes.js';
import { subscriptionRouter } from './routes/subscription.routes.js';
import { orgRouter } from './routes/org.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { mockGatewayRouter } from './routes/mockGateway.routes.js';
import { register, updateSystemMetrics } from './middleware/metrics.js';
import { isRedisAvailable, getRedisClient } from './cache/redis.js';
import { migrate } from './db/migrate.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

// Capture raw body buffer for cryptographically accurate webhook signature verification
app.use(
  express.json({
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

app.use(express.urlencoded({ extended: true }));

// Serve static admin dashboard
app.use('/admin', express.static(path.join(__dirname, 'admin/public')));

// Prometheus Metrics
app.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  await updateSystemMetrics();
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health check
app.get('/health', (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    replica: process.env.REPLICA_ID || 'api-1',
    timestamp: new Date().toISOString(),
    redis_available: isRedisAvailable(),
  });
});

// Mount API v1 Routers
app.use('/v1', walletRouter);
app.use('/v1/webhooks', webhookRouter);
app.use('/v1', subscriptionRouter);
app.use('/v1', orgRouter);
app.use('/v1', adminRouter);
app.use('/v1', mockGatewayRouter);

// Initialize Redis connection
getRedisClient();

const PORT = Number(process.env.PORT) || 4000;

if (process.env.NODE_ENV !== 'test' && process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      await migrate();
    } catch (err) {
      console.warn('[DB] Automatic startup migration failed:', err);
    }

    app.listen(PORT, () => {
      console.log(`[Billing Ledger Server] Running on http://localhost:${PORT}`);
      console.log(`[Admin Dashboard] Available at http://localhost:${PORT}/admin`);
      console.log(`[Prometheus Metrics] Available at http://localhost:${PORT}/metrics`);
    });
  })();
}
