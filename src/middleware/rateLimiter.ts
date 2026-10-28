import { Request, Response, NextFunction } from 'express';
import { getRedisClient, isRedisAvailable } from '../cache/redis.js';
import { AuthenticatedRequest } from './auth.js';

// Fallback in-memory store if Redis is unavailable
const memoryRateMap = new Map<string, number[]>();

export function createSlidingWindowLimiter(windowMs: number, maxRequests: number, keyPrefix: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    let keyIdentifier = req.ip || 'anonymous';
    if (req.user?.orgId) {
      keyIdentifier = `org:${req.user.orgId}`;
    } else if (req.user?.userId) {
      keyIdentifier = `user:${req.user.userId}`;
    }

    const key = `ratelimit:${keyPrefix}:${keyIdentifier}`;
    const now = Date.now();
    const clearBefore = now - windowMs;

    if (isRedisAvailable()) {
      const redis = getRedisClient();
      if (redis) {
        try {
          const multi = redis.multi();
          multi.zremrangebyscore(key, 0, clearBefore);
          multi.zadd(key, now, `${now}-${Math.random()}`);
          multi.zcard(key);
          multi.expire(key, Math.ceil(windowMs / 1000));
          const results = await multi.exec();

          const count = results?.[2]?.[1] as number;
          if (count > maxRequests) {
            res.status(429).json({
              error: 'Rate limit exceeded. Please retry later.',
              retryAfterSeconds: Math.ceil(windowMs / 1000),
            });
            return;
          }
          return next();
        } catch {
          // Fall back to memory
        }
      }
    }

    // In-memory sliding window
    let timestamps = memoryRateMap.get(key) || [];
    timestamps = timestamps.filter((t) => t > clearBefore);
    if (timestamps.length >= maxRequests) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please retry later.',
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
      return;
    }
    timestamps.push(now);
    memoryRateMap.set(key, timestamps);
    next();
  };
}

export const userRateLimiter = createSlidingWindowLimiter(60000, 100, 'user');
export const webhookRateLimiter = createSlidingWindowLimiter(60000, 30, 'webhook');
