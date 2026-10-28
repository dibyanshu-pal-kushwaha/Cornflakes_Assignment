# Architecture & System Design Document
**Candidate:** Dibyanshu Pal Kushwaha  
**Project:** Credits & Billing Ledger (Cornflakes Media Assessment)  
**System Mission:** A high-throughput, mission-critical billing backend that mathematically guarantees zero money lost or duplicated under hostile networks, out-of-order webhooks, high concurrency, and unexpected crashes.

---

## 1. Schema & Ledger Design

### Double-Entry Core
Every credit movement is balanced between two accounts in a single atomic database transaction. The equation strictly holds:
$$\sum \text{amount} = 0$$

- **Account Taxonomy**:
  - `system:grants` (Equity / Issuance account for credit creation)
  - `wallet:<wallet_id>` (Customer credit liability / spendable balance)
  - `system:revenue` (Recognized platform revenue from consumed generations)
  - `system:breakage` (Platform revenue recognized upon bucket expiry)
  - `system:clawback` (Contra-revenue account for processed refunds)
  - `system:receivables` (Asset account for negative shortfall debt owed by users)

### Immutability & Append-Only Guarantees
- The `ledger_entries` and `ledger_transactions` tables are strictly append-only.
- PostgreSQL database triggers (`trg_prevent_ledger_entries_mutation`, `trg_prevent_ledger_transactions_mutation`) abort any `UPDATE` or `DELETE` attempt at the database engine level with `RAISE EXCEPTION`.
- Corrections and adjustments are applied exclusively through balancing counter-entries.

---

## 2. Invariants & Verification Engine

The system continuously verifies five core mathematical invariants via `make verify`:

1. **Transaction Balance Invariant**: For every `transaction_id`, $\sum \text{amount} = 0$.
2. **Wallet Sum Invariant**: For every wallet, `balance` $\equiv \sum \text{ledger\_entries.amount}$ for that wallet.
3. **Non-Negativity Invariant**: `balance >= 0`, `reserved_balance >= 0`, and `receivable_balance >= 0` enforced by PostgreSQL `CHECK` constraints and application locking.
4. **Reservation Matching Invariant**: Every committed reservation has a corresponding balanced debit entry referencing its reservation ID in `ledger_transactions`.
5. **Grants Conservation Invariant**: Total credits issued to buckets $\equiv |\sum \text{ledger\_entries}(\text{account} = \text{'system:grants'})|$.

---

## 3. Concurrency & Locking Strategy

### Why PostgreSQL `SELECT ... FOR UPDATE` was Chosen
We evaluated three approaches for concurrent credit reservations:
1. **Serializable Isolation**: Generates frequent serialization failures (`40001: could not serialize access due to read/write dependencies`) under 100 parallel requests, requiring expensive application-level retry loops with exponential jitter.
2. **Conditional Atomic Updates (`UPDATE ... WHERE balance - reserved >= amount`)**: Works for single-bucket deductions, but fails when credits must be allocated across multiple discrete buckets ordered by expiry date (FIFO).
3. **Pessimistic Row-Level Locking (`SELECT ... FOR UPDATE`)**: **Chosen Approach**. By locking the target `wallets` row and candidate `credit_buckets` rows in a consistent order (`ORDER BY expires_at ASC, id ASC`), transactions are cleanly serialized per wallet. With 100 concurrent reserve requests against a balance of 10:
   - Exactly 10 succeed.
   - Exactly 90 receive clean, deterministic `400 Insufficient Credits` errors.
   - Zero deadlocks, zero overspend, and zero serialization rollbacks.

---

## 4. Webhook Intake Pipeline & Outbox Engine

```
[ Mock Gateway ] --(HMAC-SHA256, Raw Body)--> [ /v1/webhooks/gateway ]
                                                       |
                                            (Validate Signature & Age)
                                            (Dedupe by event_id & payment_id)
                                                       |
                                           [ webhook_events (Outbox) ]
                                                       |
                                             [ Outbox Worker ]
                                           /         |         \
                         Payment Succeeded     Refund Arrived     Prerequisite Missing
                                |                    |                     |
                      Grant Buckets & Ledger   Clawback/Shortfall    Park (status='parked')
                                |                                          |
                      Unpark Waiting Events <------------------------------+
```

### Key Resiliency Guarantees:
- **Raw Body HMAC Verification**: Verification occurs over `req.rawBody` buffer before JSON deserialization to prevent signature malleability.
- **Timestamp Freshness**: Payloads older than 300 seconds are rejected (`StaleTimestampError`).
- **Two-Tier Deduplication**:
  1. Primary deduplication by `event_id`.
  2. Secondary deduplication by `payment_id` against `processed_payments` (prevents duplicate credits when gateway sends both `payment.succeeded` and `charge.settled`).
- **Out-of-Order Parking**: If a refund arrives before its corresponding payment event, the worker parks the event with `park_reason = 'waiting_for_payment:<id>'`. Once the payment arrives and settles, the worker unparks the refund and processes it in the next loop.
- **Dead-Letter State**: After 5 failed retry attempts with exponential backoff, failed webhooks transition to `dead_letter` for operator inspection and one-click replay.

---

## 5. Credit Buckets & Expiry Rules

- **Bucket Sources & Default Lifetimes**:
  - `purchased`: 12 months (365 days)
  - `subscription`: End of billing cycle (30 days)
  - `promo`: 30 days
- **Consumption Strategy**: Strict FIFO by `expires_at ASC`. The soonest-to-expire bucket is consumed first to minimize breakage for customers.
- **Quote / Reserve Agreement**: `POST /v1/quote` previews the bucket allocation plan without taking locks; `POST /v1/reserve` locks and allocates against those exact buckets.
- **Expiry without Balance Modification**: The nightly sweep expires credits by executing balanced ledger entries (`wallet:<id>` $\rightarrow$ `system:breakage`), never by directly mutating balances without audit history.

---

## 6. Subscriptions, Proration & Dunning State Machine

### Catalog Management
Plans catalog is managed via declarative JSON with Zod schema validation and dry-run diff checking (`POST /v1/plans/import?dry_run=true`).

### Dunning State Machine
```
[ Active ] --(Renewal Failed)--> [ Grace Period (Retry +1d) ]
                                          |
                                 (Retry +3d, +7d)
                                          |
                                          v
                                    [ Suspended ] --(+14d)--> [ Cancelled ]
                                          |
                               (Payment Succeeded)
                                          |
                                          v
                                    [ Active (Recovered) ]
```
At any point during grace period or suspension, successful payment immediately recovers the subscription to `active`.

### Proration
When upgrading or changing plans mid-cycle, unused days in the current billing cycle are calculated as a fraction $f = \frac{\text{remaining\_ms}}{\text{cycle\_ms}}$. The user is charged the difference between prorated new plan and old plan, and credited with the prorated credit delta.

---

## 7. Institutional Seats & Pro-Rata Billing

- Organizations manage pools of seats with Role-Based Access Control (`owner`, `admin`, `member`).
- Roster upload is idempotent: syncing the same roster twice produces zero duplicate seats and zero duplicate charges.
- Mid-month additions are billed pro-rata: $P = \text{SeatPrice} \times \frac{\text{DaysRemaining}}{\text{DaysInMonth}}$, and prorated credits are granted directly to the member wallet.

---

## 8. Safe Cache & Observability

- **Cache Rule**: Balance reads are cached in Redis under `wallet:v1:<id>`. Each wallet row has a monotonic `version` column incremented on every balance-altering transaction. Reads specify an expected minimum version; if the cached version is stale or Redis is unreachable, the system falls back seamlessly to PostgreSQL and heals the cache write-through.
- **Metrics**: Exposed at `/metrics` via Prometheus client:
  - `webhook_lag_seconds`: Event generation to processing latency.
  - `outbox_depth`: Current pending events in outbox.
  - `dead_letters_count`: Total dead-letter events.
  - `reconciliation_differences`: Discrepancies detected between gateway and ledger.
  - `reserve_success_rate`: Ratio of successful vs failed reserves.
- **Structured Logs**: Include `payment_id`, `ledger_id`, `user_id`, and `trace_id`.

---

## 9. Convergence Sweeps & Reconciler

1. **Hourly Grant Sweep**: Reconciles confirmed gateway payments against local ledger records, recovering any lost webhooks (Trap T6).
2. **Distributed Mutual Exclusion**: Uses PostgreSQL advisory locks (`pg_try_advisory_lock`), ensuring that even when multiple replicas or workers run sweeps simultaneously, exactly one executes and no double grants occur (Trap T10).
3. **Reconciler**: Compares gateway report with ledger truth, classifies differences (`missing_credit`, `refund_not_applied`, `wallet_balance_mismatch`), automatically heals safe discrepancies, and emits alerts for manual review.

---

## 10. What We Cut & Trade-Offs

1. **Kafka / RabbitMQ vs PostgreSQL Transactional Outbox**:
   - *Considered*: External message broker (Kafka/RabbitMQ).
   - *Decision*: Chose PostgreSQL transactional outbox. It eliminates dual-write race conditions and distributed 2PC transactions between database and message broker, guaranteeing that webhook receipts and outbox records commit together atomically.
2. **Multi-Currency Dynamic Conversion Table**:
   - Money is strictly stored in minor integer units (USD cents). Multi-currency rates were stabilized on integer basis points to prevent floating-point rounding errors.
3. **Complex Event Sourcing Replay Engine**:
   - Rebuilding entire databases from raw events was streamlined to incremental ledger-based reconciliation (`repairWalletFromLedger`), delivering immediate sub-second healing without requiring full event snapshotting infrastructure.
