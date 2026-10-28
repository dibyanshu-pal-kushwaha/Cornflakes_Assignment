import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { WalletService } from '../src/services/wallet.service.js';
import { WalletCache } from '../src/cache/wallet.cache.js';
import { pool } from '../src/db/connection.js';

describe('Safe Cache & Self-Repair (Trap T9)', () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('T9: Stale cached balance in Redis is detected via version stamp and auto-heals from Postgres', async () => {
    const userId = `t9_user_${Date.now()}`;
    const wallet = await WalletService.getOrCreateWallet(userId);

    // Initial grant: 300 credits
    await WalletService.grantCredits(wallet.id, 300, 'purchased', 't9_grant');
    const freshWallet = await WalletService.getWallet(wallet.id);
    expect(Number(freshWallet.balance)).toBe(300);

    // Simulate stale cache: inject an obsolete balance (e.g. 100 with version 1)
    await WalletCache.set({
      id: wallet.id,
      user_id: userId,
      balance: 100,
      reserved_balance: 0,
      receivable_balance: 0,
      version: 1, // Stale version
      status: 'active',
    });

    // Read wallet requiring current version (version 2)
    const readWallet = await WalletService.getWallet(wallet.id, Number(freshWallet.version));

    // Must return the true balance from Postgres (300), NOT stale cached 100
    expect(Number(readWallet.balance)).toBe(300);

    // Verify cache has been repaired
    const repairedCache = await WalletCache.get(wallet.id);
    if (repairedCache) {
      expect(Number(repairedCache.balance)).toBe(300);
      expect(Number(repairedCache.version)).toBe(Number(freshWallet.version));
    }
  });
});
