# Cornflakes Media — Credits & Billing Ledger

**Candidate:** Dibyanshu Pal Kushwaha  
**Assessment:** 8-Hour Technical Project — Backend: Exactly-Once Payments, Wallet Ledger & Seat Billing  
**Tech Stack:** Node.js 22 LTS, TypeScript (strict mode), Express, PostgreSQL 16 (strict append-only schema & triggers), Redis 7 (safe cache & rate limiting), Docker Compose.

---

## Quick Start (One Command)

To build and start the entire multi-replica stack (API Replica 1, API Replica 2, Outbox Worker, PostgreSQL, and Redis):

```bash
docker compose up --build
```

### Endpoints Once Running:
- **API Replica 1:** `http://localhost:4000`
- **API Replica 2:** `http://localhost:4002`
- **Admin Dashboard UI:** `http://localhost:4000/admin`
- **Prometheus Metrics:** `http://localhost:4000/metrics`
- **Healthcheck:** `http://localhost:4000/health`

---

## Key Commands & Verification

| Command | Description |
| :--- | :--- |
| `make test` | Executes the complete automated test suite (Vitest) covering all traps T1–T12 |
| `make verify` | Runs the 5 core mathematical ledger invariants and demonstrates corruption detection |
| `make chaos` | Executes live chaos scenarios for Traps T1, T4, T5, and T9 |
| `make load` | Runs high-concurrency webhook storms (100 req/s) and 5,000 member roster syncs |
| `make seed` | Imports and validates the subscription catalog with dry-run diff checking |

---

## 1. Ledger Invariants (`make verify`)

The assessment requires mathematically proving that money is never lost or doubled. Run:

```bash
npm run verify -- --demo-corruption
# or
make verify
```

### The 5 Verified Invariants:
1. **Transaction Zero Balance:** Every ledger transaction is strictly double-entry ($\sum \text{amount} = 0$).
2. **Wallet Balance Sum:** Every customer's wallet balance matches the sum of immutable ledger entries.
3. **Non-Negativity:** No negative balances or negative credit buckets exist.
4. **Committed Reservations:** Every committed generation reservation has a matching debit entry in the ledger.
5. **Grants Conservation:** Total credits issued to buckets equals total debits from `system:grants`.

> **Corruption Injection Demo:** Running with `--demo-corruption` injects unauthorized balance manipulation into a wallet row by hand, shows that `make verify` immediately flags the corrupted wallet and exact discrepancy, and restores it to ledger truth.

---

## 2. Injected Clock Control

To test cycles, expiry, and dunning across months in seconds, the system features a virtual clock engine:

```bash
# Check current virtual time
curl http://localhost:4000/v1/time

# Advance time by 30 days
curl -X POST http://localhost:4000/v1/time/advance \
  -H "Content-Type: application/json" \
  -d '{"days": 30}'

# Advance time by 3600 seconds
curl -X POST http://localhost:4000/v1/time/advance \
  -H "Content-Type: application/json" \
  -d '{"seconds": 3600}'

# Reset clock back to real time
curl -X POST http://localhost:4000/v1/time/reset
```

The admin dashboard at `http://localhost:4000/admin` also has interactive buttons for `+1 Day`, `+30 Days`, and `Reset`.

---

## 3. Traps We Designed For & Automated Tests

| # | Trap Scenario | System Behavior & Defense | Test File |
| :---: | :--- | :--- | :--- |
| **T1** | Same webhook delivered 5 times concurrently | Exactly one credit granted, one ledger entry; deduplicated via outbox transaction lock. | `tests/t1_t2_t3_webhooks.test.ts` |
| **T2** | Two different events for one payment | Deduplication on `payment_id` against `processed_payments` table; no double credit. | `tests/t1_t2_t3_webhooks.test.ts` |
| **T3** | Refund event arrives before payment event | Outbox parks refund with `waiting_for_payment:<id>`; unparks and applies upon payment arrival. | `tests/t1_t2_t3_webhooks.test.ts` |
| **T4** | 100 parallel reserves against balance for 10 | PostgreSQL `SELECT ... FOR UPDATE` locks wallet & buckets; exactly 10 succeed, balance never negative; unfinished reserves auto-expire. | `tests/t4_concurrency.test.ts` |
| **T5** | Replica killed between debit and ledger write | ACID database transaction guarantees atomic rollback: both or neither; invariants hold. | `tests/t5_atomicity.test.ts` |
| **T6** | Renewal webhook never arrives | Hourly convergence sweep compares gateway settled report with ledger and grants missing credit. | `tests/t6_t10_sweeps.test.ts` |
| **T7** | Roster uploaded twice; member added mid-month | Idempotent sync; pro-rata calculation is exact based on days remaining; no double seat. | `tests/t7_roster_prorata.test.ts` |
| **T8** | Refund after half credits spent | Claws back remaining credits; records shortfall as an accounts receivable; balance never silently negative. | `tests/t8_refunds.test.ts` |
| **T9** | Redis down, then back with old value | Version-stamped reads detect stale cache; automatically bypasses cache and repairs to Postgres truth. | `tests/t9_cache_repair.test.ts` |
| **T10** | Two sweeps start at the same moment | Distributed mutual exclusion via `pg_try_advisory_lock`; one runs, other skips; no double grants. | `tests/t6_t10_sweeps.test.ts` |
| **T11** | Credits expire while reservation is open | Nightly sweep expires only unreserved portion; active reservations honored or released cleanly; ledger balanced. | `tests/t11_expiry_reservation.test.ts` |
| **T12** | Hand corruption of wallet row | `make verify` and Reconciler identify corrupted wallet ID and exact difference. | `tests/t12_corruption_invariants.test.ts` |

---

## 4. Architecture Overview

Please see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for full architectural justifications, locking comparisons (`SELECT FOR UPDATE` vs Serializable vs Conditional Updates), outbox vs queue trade-offs, and state machine diagrams.
