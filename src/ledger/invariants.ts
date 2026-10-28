import { query, withTransaction } from '../db/connection.js';

export interface InvariantResult {
  name: string;
  passed: boolean;
  details?: string;
  discrepancies?: any[];
}

export interface VerificationReport {
  timestamp: string;
  allPassed: boolean;
  results: InvariantResult[];
}

export class LedgerInvariants {
  /**
   * Runs all 5 critical ledger invariants.
   */
  static async verifyAll(): Promise<VerificationReport> {
    const results: InvariantResult[] = [];

    // Invariant 1: Double-entry balance across all transactions (Sum of amount === 0 per transaction_id)
    const txBalance = await this.verifyTransactionZeroBalance();
    results.push(txBalance);

    // Invariant 2: Wallet balance === sum of ledger entries for that wallet
    const walletBalance = await this.verifyWalletSumMatchesLedger();
    results.push(walletBalance);

    // Invariant 3: No negative wallet balance (and no negative bucket balances)
    const nonNegative = await this.verifyNoNegativeBalances();
    results.push(nonNegative);

    // Invariant 4: Every committed reservation has a matching debit in the ledger
    const reservations = await this.verifyCommittedReservationsHaveDebits();
    results.push(reservations);

    // Invariant 5: Total credits issued === sum of grants (system:grants debits == credits to user wallets)
    const grants = await this.verifyCreditsIssuedEqualsGrants();
    results.push(grants);

    const allPassed = results.every((r) => r.passed);
    return {
      timestamp: new Date().toISOString(),
      allPassed,
      results,
    };
  }

  /**
   * Invariant 1: sum(amount) == 0 for every transaction
   */
  private static async verifyTransactionZeroBalance(): Promise<InvariantResult> {
    const sql = `
      SELECT transaction_id, SUM(amount) as imbalance
      FROM ledger_entries
      GROUP BY transaction_id
      HAVING SUM(amount) != 0;
    `;
    const res = await query(sql);
    if (res.rows.length === 0) {
      return { name: 'Every transaction is strictly balanced (sum = 0)', passed: true };
    }
    return {
      name: 'Every transaction is strictly balanced (sum = 0)',
      passed: false,
      details: `Found ${res.rows.length} unbalanced transactions`,
      discrepancies: res.rows,
    };
  }

  /**
   * Invariant 2: wallet.balance === sum(ledger entries for that wallet)
   */
  private static async verifyWalletSumMatchesLedger(): Promise<InvariantResult> {
    const sql = `
      SELECT 
        w.id AS wallet_id,
        w.user_id,
        w.balance AS recorded_balance,
        COALESCE(SUM(le.amount), 0) AS calculated_ledger_sum,
        (w.balance - COALESCE(SUM(le.amount), 0)) AS difference
      FROM wallets w
      LEFT JOIN ledger_entries le ON w.id = le.wallet_id
      GROUP BY w.id, w.user_id, w.balance
      HAVING w.balance != COALESCE(SUM(le.amount), 0);
    `;
    const res = await query(sql);
    if (res.rows.length === 0) {
      return { name: 'Wallet balance matches sum of ledger entries', passed: true };
    }
    return {
      name: 'Wallet balance matches sum of ledger entries',
      passed: false,
      details: `Found ${res.rows.length} corrupted/mismatched wallets`,
      discrepancies: res.rows.map((r) => ({
        wallet_id: r.wallet_id,
        user_id: r.user_id,
        recorded_balance: Number(r.recorded_balance),
        calculated_ledger_sum: Number(r.calculated_ledger_sum),
        difference: Number(r.difference),
      })),
    };
  }

  /**
   * Invariant 3: No negative balances anywhere
   */
  private static async verifyNoNegativeBalances(): Promise<InvariantResult> {
    const sql = `
      SELECT id, user_id, balance, reserved_balance 
      FROM wallets 
      WHERE balance < 0 OR reserved_balance < 0;
    `;
    const res = await query(sql);
    if (res.rows.length === 0) {
      return { name: 'No negative balances exist', passed: true };
    }
    return {
      name: 'No negative balances exist',
      passed: false,
      details: `Found ${res.rows.length} negative wallets`,
      discrepancies: res.rows,
    };
  }

  /**
   * Invariant 4: Every committed reservation has a matching debit
   */
  private static async verifyCommittedReservationsHaveDebits(): Promise<InvariantResult> {
    const sql = `
      SELECT r.id AS reservation_id, r.wallet_id, r.amount, lt.id AS tx_id
      FROM reservations r
      LEFT JOIN ledger_transactions lt 
        ON lt.reference_id = r.id::text AND lt.type = 'commit'
      WHERE r.status = 'committed' AND lt.id IS NULL;
    `;
    const res = await query(sql);
    if (res.rows.length === 0) {
      return { name: 'Every committed reservation has a matching ledger debit', passed: true };
    }
    return {
      name: 'Every committed reservation has a matching ledger debit',
      passed: false,
      details: `Found ${res.rows.length} committed reservations without debit entry`,
      discrepancies: res.rows,
    };
  }

  /**
   * Invariant 5: Total credits issued === sum of grants
   */
  private static async verifyCreditsIssuedEqualsGrants(): Promise<InvariantResult> {
    const sql = `
      SELECT 
        (SELECT COALESCE(ABS(SUM(amount)), 0) FROM ledger_entries WHERE account_id = 'system:grants') AS total_grants_issued,
        (SELECT COALESCE(SUM(amount_issued), 0) FROM credit_buckets) AS total_bucket_credits_issued;
    `;
    const res = await query(sql);
    const grantsIssued = BigInt(res.rows[0].total_grants_issued);
    const bucketCredits = BigInt(res.rows[0].total_bucket_credits_issued);

    if (grantsIssued === bucketCredits) {
      return {
        name: 'Total credits issued equals sum of grants',
        passed: true,
        details: `Grants issued: ${grantsIssued}, Bucket credits: ${bucketCredits}`,
      };
    }
    return {
      name: 'Total credits issued equals sum of grants',
      passed: false,
      details: `Mismatch: System grants = ${grantsIssued}, Bucket credits = ${bucketCredits}`,
      discrepancies: [{ system_grants: grantsIssued.toString(), bucket_credits: bucketCredits.toString() }],
    };
  }

  /**
   * Injects a corruption into a wallet row for testing T12 / make verify demonstration.
   */
  static async injectWalletCorruption(walletId: string, deltaAmount: number): Promise<void> {
    await query('UPDATE wallets SET balance = balance + $1 WHERE id = $2', [deltaAmount, walletId]);
  }

  /**
   * Repairs the wallet row back to ledger truth.
   */
  static async repairWalletFromLedger(walletId: string): Promise<number> {
    const res = await query(
      `UPDATE wallets w
       SET balance = sub.sum_amt, updated_at = NOW(), version = version + 1
       FROM (
         SELECT COALESCE(SUM(amount), 0) AS sum_amt 
         FROM ledger_entries 
         WHERE wallet_id = $1
       ) sub
       WHERE w.id = $1
       RETURNING w.balance;`,
      [walletId]
    );
    return Number(res.rows[0]?.balance || 0);
  }
}
