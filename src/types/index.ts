export type AccountType = 
  | 'system:grants'
  | 'system:revenue'
  | 'system:breakage'
  | 'system:clawback'
  | 'system:receivables'
  | `wallet:${string}`;

export type LedgerTransactionType =
  | 'grant_purchase'
  | 'grant_subscription'
  | 'grant_promo'
  | 'grant_seat'
  | 'reserve'
  | 'commit'
  | 'release'
  | 'expire'
  | 'refund_clawback'
  | 'refund_shortfall'
  | 'correction';

export interface Wallet {
  id: string;
  user_id: string;
  org_id: string | null;
  balance: number;
  reserved_balance: number;
  receivable_balance: number;
  currency: string;
  status: 'active' | 'suspended';
  version: number;
  created_at: Date;
  updated_at: Date;
}

export type BucketSource = 'purchased' | 'subscription' | 'promo';

export interface CreditBucket {
  id: string;
  wallet_id: string;
  source: BucketSource;
  amount_issued: number;
  amount_remaining: number;
  amount_reserved: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface BucketAllocation {
  bucket_id: string;
  amount: number;
  source: BucketSource;
  expires_at: string;
}

export interface Reservation {
  id: string;
  wallet_id: string;
  idempotency_key: string;
  amount: number;
  status: 'active' | 'committed' | 'released' | 'expired';
  bucket_allocations: BucketAllocation[];
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerTransaction {
  id: string;
  type: LedgerTransactionType;
  reference_id: string | null;
  idempotency_key: string | null;
  description: string | null;
  created_at: Date;
}

export interface LedgerEntry {
  id: string;
  transaction_id: string;
  account_id: string;
  wallet_id: string | null;
  bucket_id: string | null;
  amount: number;
  created_at: Date;
}

export interface WebhookEventPayload {
  event_id: string;
  event_type: string;
  payment_id: string;
  wallet_id?: string;
  user_id?: string;
  amount_minor: number;
  credits_granted?: number;
  currency: string;
  source_type?: BucketSource;
  plan_id?: string;
  cycle_id?: string;
  reason?: string;
  created_at: number; // unix timestamp in seconds
}

export interface WebhookRecord {
  id: string;
  event_id: string;
  payment_id: string;
  event_type: string;
  payload: WebhookEventPayload;
  raw_body: string;
  signature: string;
  status: 'pending' | 'processing' | 'completed' | 'parked' | 'dead_letter';
  retry_count: number;
  park_reason: string | null;
  last_error: string | null;
  received_at: Date;
  processed_at: Date | null;
}

export interface PlanCatalogItem {
  id: string;
  name: string;
  credits_per_cycle: number;
  price_minor: number;
  currency: string;
  cycle_interval_days: number;
  active: boolean;
}

export interface AuthUser {
  userId: string;
  role: 'admin' | 'user';
  orgId?: string;
}
