import { getRedisClient, isRedisAvailable } from './redis.js';
import { Wallet } from '../types/index.js';

export interface CachedWallet {
  id: string;
  user_id: string;
  balance: number;
  reserved_balance: number;
  receivable_balance: number;
  version: number;
  status: string;
  cached_at: number;
}

const CACHE_PREFIX = 'wallet:v1:';
const TTL_SECONDS = 300;

export class WalletCache {
  private static getKey(walletId: string): string {
    return `${CACHE_PREFIX}${walletId}`;
  }

  /**
   * Get cached balance. If expectedMinVersion is provided and cache is older,
   * returns null so DB is read.
   */
  static async get(walletId: string, expectedMinVersion?: number): Promise<CachedWallet | null> {
    if (!isRedisAvailable()) return null;
    const redis = getRedisClient();
    if (!redis) return null;

    try {
      const data = await redis.get(this.getKey(walletId));
      if (!data) return null;

      const cached: CachedWallet = JSON.parse(data);
      if (expectedMinVersion !== undefined && cached.version < expectedMinVersion) {
        // Cache is stale! Evict or let caller repair
        await redis.del(this.getKey(walletId));
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  static async set(wallet: {
    id: string;
    user_id: string;
    balance: number;
    reserved_balance: number;
    receivable_balance: number;
    version: number;
    status: string;
  }): Promise<void> {
    if (!isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;

    try {
      const payload: CachedWallet = {
        id: wallet.id,
        user_id: wallet.user_id,
        balance: Number(wallet.balance),
        reserved_balance: Number(wallet.reserved_balance),
        receivable_balance: Number(wallet.receivable_balance),
        version: Number(wallet.version),
        status: wallet.status,
        cached_at: Date.now(),
      };
      await redis.set(this.getKey(wallet.id), JSON.stringify(payload), 'EX', TTL_SECONDS);
    } catch {
      // Redis write failure should never fail the transaction or caller
    }
  }

  static async invalidate(walletId: string): Promise<void> {
    if (!isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;
    try {
      await redis.del(this.getKey(walletId));
    } catch {}
  }
}
