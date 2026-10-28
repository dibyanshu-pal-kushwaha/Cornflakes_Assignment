import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let redisClient: Redis | null = null;
let isConnected = false;

export function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      retryStrategy(times: number) {
        if (times > 5) return null;
        return Math.min(times * 100, 2000);
      },
      enableOfflineQueue: false,
    });

    redisClient.on('connect', () => {
      isConnected = true;
      console.log('[Redis] Connected successfully');
    });

    redisClient.on('error', (_err: any) => {
      isConnected = false;
      // Suppress noisy logs during simulated chaos
    });

    redisClient.on('close', () => {
      isConnected = false;
    });

    return redisClient;
  } catch (err) {
    console.warn('[Redis] Unable to initialize Redis client; falling back to DB/in-memory');
    return null;
  }
}

export function isRedisAvailable(): boolean {
  return isConnected && redisClient?.status === 'ready';
}
