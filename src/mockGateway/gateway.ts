import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ClockService } from '../services/clock.service.js';
import { GatewayPaymentReport } from '../services/reconciler.service.js';

export interface ChaosConfig {
  dropWebhooks: boolean;
  duplicateWebhooks: boolean;
  duplicateCount: number;
  delayMs: number;
}

export class MockGateway {
  private static confirmedPayments: Map<string, GatewayPaymentReport> = new Map();
  private static chaos: ChaosConfig = {
    dropWebhooks: false,
    duplicateWebhooks: false,
    duplicateCount: 2,
    delayMs: 0,
  };

  static setChaos(config: Partial<ChaosConfig>): void {
    this.chaos = { ...this.chaos, ...config };
    console.log('[MockGateway] Chaos configuration updated:', this.chaos);
  }

  static getChaos(): ChaosConfig {
    return { ...this.chaos };
  }

  static signPayload(rawBody: string, secret?: string): string {
    const s = secret || process.env.WEBHOOK_SECRET || 'whsec_mock_gateway_shared_secret_key_8829';
    const nowSec = Math.floor(ClockService.nowSync().getTime() / 1000);
    const signature = crypto.createHmac('sha256', s).update(`${nowSec}.${rawBody}`).digest('hex');
    return `t=${nowSec},v1=${signature}`;
  }

  /**
   * Creates and registers a successful payment order at the gateway.
   */
  static createPayment(userId: string, amountMinor: number, credits?: number): {
    payment_id: string;
    payload: any;
    signature: string;
  } {
    const paymentId = `pay_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const grantedCredits = credits || Math.floor(amountMinor / 10);

    const reportItem: GatewayPaymentReport = {
      payment_id: paymentId,
      user_id: userId,
      amount_minor: amountMinor,
      credits: grantedCredits,
      status: 'settled',
    };
    this.confirmedPayments.set(paymentId, reportItem);

    const payload = {
      event_id: `evt_${uuidv4().replace(/-/g, '').substring(0, 16)}`,
      event_type: 'payment.succeeded',
      payment_id: paymentId,
      user_id: userId,
      amount_minor: amountMinor,
      credits_granted: grantedCredits,
      currency: 'USD',
      source_type: 'purchased',
      created_at: Math.floor(ClockService.nowSync().getTime() / 1000),
    };

    const rawBody = JSON.stringify(payload);
    const signature = this.signPayload(rawBody);

    return { payment_id: paymentId, payload, signature };
  }

  /**
   * Creates a refund event at the gateway.
   */
  static createRefund(paymentId: string, credits?: number): {
    payload: any;
    signature: string;
  } {
    const existing = this.confirmedPayments.get(paymentId);
    if (existing) {
      existing.status = 'refunded';
    }

    const payload = {
      event_id: `evt_ref_${uuidv4().replace(/-/g, '').substring(0, 16)}`,
      event_type: 'charge.refunded',
      payment_id: paymentId,
      credits_granted: credits || existing?.credits || 100,
      amount_minor: existing?.amount_minor || 1000,
      currency: 'USD',
      created_at: Math.floor(ClockService.nowSync().getTime() / 1000),
    };

    const rawBody = JSON.stringify(payload);
    const signature = this.signPayload(rawBody);

    return { payload, signature };
  }

  /**
   * Returns true ground-truth payment settlements for reconciler comparison.
   */
  static getSettledPaymentsReport(): GatewayPaymentReport[] {
    return Array.from(this.confirmedPayments.values());
  }

  /**
   * Registers a payment directly into gateway truth (for tests)
   */
  static registerConfirmedPayment(report: GatewayPaymentReport): void {
    this.confirmedPayments.set(report.payment_id, report);
  }

  static clear(): void {
    this.confirmedPayments.clear();
    this.chaos = {
      dropWebhooks: false,
      duplicateWebhooks: false,
      duplicateCount: 2,
      delayMs: 0,
    };
  }
}
