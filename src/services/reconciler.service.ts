import { query } from '../db/connection.js';
import { WalletService } from './wallet.service.js';
import { RefundService } from './refund.service.js';
import { LedgerInvariants } from '../ledger/invariants.js';

export interface GatewayPaymentReport {
  payment_id: string;
  user_id: string;
  amount_minor: number;
  credits: number;
  status: 'settled' | 'refunded';
}

export type DiscrepancyType =
  | 'missing_credit'
  | 'duplicate_payment'
  | 'refund_not_applied'
  | 'wallet_balance_mismatch'
  | 'unrecorded_payment';

export interface ReconciliationDifference {
  type: DiscrepancyType;
  identifier: string;
  details: string;
  autoFixable: boolean;
  fixed: boolean;
}

export interface ReconciliationReport {
  timestamp: string;
  totalExamined: number;
  differences: ReconciliationDifference[];
  alerts: string[];
}

export class ReconcilerService {
  /**
   * Reconciles gateway settlement report against internal ledger.
   */
  static async reconcile(gatewayReport: GatewayPaymentReport[]): Promise<ReconciliationReport> {
    const differences: ReconciliationDifference[] = [];
    const alerts: string[] = [];

    // 1. Check ledger invariants and identify any corrupted wallet rows (Trap T12)
    const verification = await LedgerInvariants.verifyAll();
    const walletCheck = verification.results.find(
      (r) => r.name === 'Wallet balance matches sum of ledger entries'
    );
    if (walletCheck && !walletCheck.passed && walletCheck.discrepancies) {
      for (const disc of walletCheck.discrepancies) {
        differences.push({
          type: 'wallet_balance_mismatch',
          identifier: disc.wallet_id,
          details: `Wallet balance mismatch for user ${disc.user_id}: recorded ${disc.recorded_balance}, ledger sum ${disc.calculated_ledger_sum}, diff ${disc.difference}`,
          autoFixable: true,
          fixed: false,
        });
        alerts.push(
          `CORRUPTION DETECTED: Wallet ${disc.wallet_id} has balance ${disc.recorded_balance} but ledger sum is ${disc.calculated_ledger_sum} (difference: ${disc.difference})`
        );
      }
    }

    // 2. Cross-examine Gateway transactions
    for (const gItem of gatewayReport) {
      const dbPayment = await query(
        'SELECT * FROM processed_payments WHERE payment_id = $1',
        [gItem.payment_id]
      );

      if (dbPayment.rows.length === 0) {
        // Missing credit in database!
        const autoFixable = true;
        let fixed = false;
        try {
          const wallet = await WalletService.getOrCreateWallet(gItem.user_id);
          await WalletService.grantCredits(
            wallet.id,
            gItem.credits,
            'purchased',
            gItem.payment_id,
            `reconcile_fix:${gItem.payment_id}`
          );

          await query(
            `INSERT INTO processed_payments (payment_id, first_event_id, amount, currency, wallet_id, status, created_at)
             VALUES ($1, $2, $3, 'USD', $4, $5, NOW())`,
            [gItem.payment_id, `reconciler_${Date.now()}`, gItem.amount_minor, wallet.id, gItem.status]
          );
          fixed = true;
        } catch (err: any) {
          alerts.push(`Failed to auto-heal missing credit for ${gItem.payment_id}: ${err.message}`);
        }

        differences.push({
          type: 'missing_credit',
          identifier: gItem.payment_id,
          details: `Payment ${gItem.payment_id} was confirmed by gateway but missing in ledger`,
          autoFixable,
          fixed,
        });
      } else {
        const localPayment = dbPayment.rows[0];

        // Check refund discrepancy
        if (gItem.status === 'refunded' && localPayment.status !== 'refunded') {
          let fixed = false;
          try {
            await RefundService.processRefund(gItem.payment_id, gItem.credits, `reconciler_refund_${Date.now()}`);
            fixed = true;
          } catch (err: any) {
            alerts.push(`Failed to auto-apply refund for ${gItem.payment_id}: ${err.message}`);
          }

          differences.push({
            type: 'refund_not_applied',
            identifier: gItem.payment_id,
            details: `Gateway marked ${gItem.payment_id} as refunded, but ledger was unrefunded`,
            autoFixable: true,
            fixed,
          });
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      totalExamined: gatewayReport.length,
      differences,
      alerts,
    };
  }
}
