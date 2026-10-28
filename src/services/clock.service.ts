import { pool, query } from '../db/connection.js';

let cachedOffsetSeconds = 0;
let lastSyncedAt = 0;

export class ClockService {
  /**
   * Returns the current virtual time factoring in injected offset.
   */
  static async now(): Promise<Date> {
    const offset = await this.getOffsetSeconds();
    return new Date(Date.now() + offset * 1000);
  }

  /**
   * Synchronous now using cached offset (refreshed periodically)
   */
  static nowSync(): Date {
    return new Date(Date.now() + cachedOffsetSeconds * 1000);
  }

  static async getOffsetSeconds(): Promise<number> {
    const now = Date.now();
    if (now - lastSyncedAt < 1000) {
      return cachedOffsetSeconds;
    }
    try {
      const res = await query('SELECT offset_seconds FROM system_clock_offset WHERE id = 1');
      if (res.rows.length > 0) {
        cachedOffsetSeconds = Number(res.rows[0].offset_seconds);
        lastSyncedAt = now;
      }
    } catch {
      // In case DB is not yet migrated or unreachable
    }
    return cachedOffsetSeconds;
  }

  static async advanceSeconds(seconds: number): Promise<Date> {
    const current = await this.getOffsetSeconds();
    const newOffset = current + seconds;
    await query('UPDATE system_clock_offset SET offset_seconds = $1, updated_at = NOW() WHERE id = 1', [newOffset]);
    cachedOffsetSeconds = newOffset;
    lastSyncedAt = Date.now();
    return new Date(Date.now() + newOffset * 1000);
  }

  static async advanceDays(days: number): Promise<Date> {
    return this.advanceSeconds(days * 86400);
  }

  static async reset(): Promise<Date> {
    await query('UPDATE system_clock_offset SET offset_seconds = 0, updated_at = NOW() WHERE id = 1');
    cachedOffsetSeconds = 0;
    lastSyncedAt = Date.now();
    return new Date();
  }
}
