import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { LedgerTransactionType, AccountType } from '../types/index.js';

export interface EntryDraft {
  accountId: AccountType;
  walletId?: string | null;
  bucketId?: string | null;
  amount: number; // Positive = Credit, Negative = Debit
}

export interface TransactionDraft {
  type: LedgerTransactionType;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  description?: string;
  entries: EntryDraft[];
}

export class LedgerEngine {
  /**
   * Records a balanced double-entry transaction.
   * Enforces sum(amount) === 0 strictly in the database transaction.
   */
  static async recordTransaction(
    client: pg.PoolClient,
    draft: TransactionDraft
  ): Promise<string> {
    if (!draft.entries || draft.entries.length < 2) {
      throw new Error(`Double-entry requires at least 2 entries. Received: ${draft.entries?.length || 0}`);
    }

    // Mathematical balance verification: Sum of debits and credits MUST equal zero
    const total = draft.entries.reduce((acc, curr) => acc + BigInt(curr.amount), BigInt(0));
    if (total !== BigInt(0)) {
      throw new Error(`Ledger transaction is unbalanced! Sum of entries is ${total}, expected 0.`);
    }

    // Insert transaction record
    const txId = uuidv4();
    await client.query(
      `INSERT INTO ledger_transactions (id, type, reference_id, idempotency_key, description, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [txId, draft.type, draft.referenceId || null, draft.idempotencyKey || null, draft.description || null]
    );

    // Insert each balanced entry
    for (const entry of draft.entries) {
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, wallet_id, bucket_id, amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          uuidv4(),
          txId,
          entry.accountId,
          entry.walletId || null,
          entry.bucketId || null,
          entry.amount,
        ]
      );
    }

    return txId;
  }
}
