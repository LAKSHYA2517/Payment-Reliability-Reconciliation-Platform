# Payment Reliability & Reconciliation Platform — Project Plan

## 1. The real-world problem

Every payment system that talks to a third-party processor (Stripe, Adyen, a bank) faces the same structural problem: **the system that asks for a payment and the system that confirms it are different systems, connected by an unreliable network.**

Concretely:

- You call the processor to charge a card. The HTTP request times out. Did the charge happen or not? You don't know, and you must not guess wrong in either direction (double-charging is bad; failing to deliver goods for a charge that succeeded is also bad).
- The processor later tells you the real outcome via a **webhook** — but webhooks can arrive late, out of order, or more than once (the processor's own retry logic, or a network blip, can redeliver the same event).
- A client's app can crash and retry the same "create payment" request. Without protection, that becomes two charges for one purchase.
- Over time, your internal ledger and the processor's ledger can silently drift apart — a payment your system thinks is "pending" that the processor already settled, or vice versa. Nobody notices until finance does a monthly close and the numbers don't match.

This project builds the internal backend that a company puts **between its application and a payment processor** to make all of this safe: idempotent request handling, a strict payment state machine, deduplicated webhook ingestion, retried background processing, and a reconciliation job that catches drift before it becomes a finance incident. The processor itself is simulated (see §3) so the project is self-contained and runnable without real PSP credentials.

## 2. MVP scope

**In scope:**
- Single merchant, single currency path (USD) to start — no multi-tenant complexity.
- Create a payment, track it through a defined state machine.
- Idempotent payment creation via client-supplied idempotency key.
- A simulated PSP (processor) that asynchronously calls back via webhook.
- Webhook ingestion with signature verification and deduplication.
- Append-only audit log of every state transition.
- Background retry for failed webhook processing (not just inline try/catch).
- A reconciliation job comparing our ledger against the simulated PSP's ledger, producing a discrepancy report.
- Dockerized app + Postgres, OpenAPI docs, automated tests (unit + integration against a real Postgres).

**Explicitly out of scope for MVP** (noted as stretch goals in the roadmap):
- Real integration with an actual PSP (Stripe test mode, etc.).
- Refunds, partial captures, multi-currency/FX.
- Multi-tenancy / auth / merchants table.
- Horizontal scaling, message brokers (Kafka), distributed tracing.

Keeping scope this tight is deliberate: the goal is to go *deep* on correctness and reliability mechanics for one payment flow, not *wide* across payment features.

## 3. High-level architecture

```
                 ┌─────────────────────┐
  Client ───────▶│   API Layer         │
 (idempotency-key)│  (Express/TS)       │
                 │  - create payment    │
                 │  - get payment       │
                 │  - cancel payment    │
                 └─────────┬───────────┘
                           │ writes (in a DB transaction)
                           ▼
                 ┌─────────────────────┐
                 │   PostgreSQL         │
                 │  payments            │
                 │  payment_events      │◀── append-only audit trail
                 │  idempotency_keys    │
                 │  webhook_events      │
                 │  psp_ledger (mock)   │
                 │  reconciliation_runs │
                 └─────────┬───────────┘
                           ▲
                           │ webhook callback (HTTP POST, HMAC-signed)
                 ┌─────────┴───────────┐
                 │  Mock PSP Simulator  │  (in-process, simulates async
                 │  (background task)   │   confirmation + occasional
                 └─────────────────────┘   dupes/delays/failures)

      ┌───────────────────┐        ┌───────────────────────┐
      │ Webhook processor  │        │ Reconciliation job     │
      │ worker (retries     │        │ (scheduled, compares   │
      │ failed events)      │        │ payments vs psp_ledger)│
      └───────────────────┘        └───────────────────────┘
```

This is a **modular monolith**, not microservices. One deployable Node/TypeScript process containing clearly separated modules (API, webhook processing, reconciliation, background workers), all talking to one Postgres database. Splitting these into separate services would add network calls and deployment complexity that teach nothing extra at this project's scale — the reliability lessons (idempotency, transactions, dedup, retries) are the same either way, and a monolith lets every transition happen inside one DB transaction, which is the whole point.

The "PSP" is simulated inside the same codebase rather than integrated with real Stripe: it lets the project demonstrate realistic failure modes (duplicate webhooks, delayed webhooks, dropped webhooks, ledger drift) *deterministically and on demand*, without needing external credentials or waiting on real network timing. A real Stripe/Adyen integration is a natural stretch goal once the core mechanics work.

## 4. Core components / services

| Component | Responsibility |
|---|---|
| **API layer** | HTTP routes, request validation, idempotency-key handling, maps to Payment Service |
| **Payment Service** | Owns the state machine; the only code allowed to write `payments.status` |
| **Idempotency Store** | Records in-flight/completed requests keyed by client idempotency key; replays cached responses |
| **Webhook Receiver** | Verifies signature, deduplicates by `provider_event_id`, persists raw event, enqueues for processing |
| **Webhook Processor (worker)** | Applies a webhook event to a payment via the Payment Service; retries on failure with backoff; dead-letters after N attempts |
| **Mock PSP Simulator** | Stands in for Stripe/Adyen: accepts a "charge" call, later fires a webhook (sometimes duplicated/delayed/out-of-order on purpose), and maintains its own ledger table |
| **Audit Log Service** | Appends an immutable record for every state transition (who/what triggered it, old state, new state, timestamp) |
| **Reconciliation Job** | Periodically diffs `payments` against `psp_ledger`, writes a report of mismatches |

## 5. Database entities and relationships

```
payments
  id                 UUID PK
  idempotency_key_id UUID FK -> idempotency_keys.id (nullable, set at creation)
  external_ref       TEXT UNIQUE      -- id the mock PSP uses for this payment
  amount_cents       BIGINT
  currency           TEXT
  status             payment_status ENUM
  version            INT             -- optimistic locking / detecting concurrent writes
  created_at         TIMESTAMPTZ
  updated_at         TIMESTAMPTZ

payment_events                        -- append-only audit trail
  id            UUID PK
  payment_id    UUID FK -> payments.id
  from_status   payment_status NULL
  to_status     payment_status
  reason        TEXT              -- e.g. "webhook:charge.succeeded", "api:cancel"
  caused_by     TEXT              -- "api" | "webhook" | "reconciliation" | "system"
  metadata      JSONB
  created_at    TIMESTAMPTZ

idempotency_keys
  id            UUID PK
  key           TEXT UNIQUE       -- the client-supplied Idempotency-Key header
  request_hash  TEXT              -- hash of the request body, to detect key reuse with different payload
  status        TEXT              -- "in_progress" | "completed"
  response_body JSONB NULL
  response_status INT NULL
  created_at    TIMESTAMPTZ

webhook_events
  id                 UUID PK
  provider_event_id  TEXT UNIQUE   -- dedup key from the PSP
  payment_external_ref TEXT
  event_type         TEXT
  payload            JSONB
  status             TEXT          -- "received" | "processed" | "failed" | "dead_letter"
  attempts           INT DEFAULT 0
  received_at        TIMESTAMPTZ
  processed_at       TIMESTAMPTZ NULL

psp_ledger                          -- the simulated external source of truth
  external_ref  TEXT PK
  amount_cents  BIGINT
  currency      TEXT
  status        TEXT               -- PSP's own view of the payment
  updated_at    TIMESTAMPTZ

reconciliation_runs
  id           UUID PK
  started_at   TIMESTAMPTZ
  finished_at  TIMESTAMPTZ
  discrepancy_count INT
  report       JSONB               -- list of mismatches found
```

**Relationships:** one `payment` has many `payment_events` (1:N, audit trail); one `payment` optionally has one `idempotency_key` (the one that created it); `webhook_events` reference a payment indirectly via `external_ref` (a webhook can arrive before we're sure which payment it maps to, so it's not a hard FK); `psp_ledger` is independent and only joined against during reconciliation.

## 6. Payment state machine

```
      ┌─────────┐
      │ PENDING │  (created, PSP charge not yet confirmed)
      └────┬────┘
           │ PSP accepts charge attempt
           ▼
      ┌────────────┐
      │ PROCESSING │
      └──┬──────┬──┘
         │      │
  success│      │failure
         ▼      ▼
  ┌──────────┐ ┌────────┐
  │ SUCCEEDED│ │ FAILED │
  └──────────┘ └────────┘

  PENDING ──(client/API cancel, before PSP confirms)──▶ CANCELED
```

- `PENDING` → `PROCESSING`: set when we successfully hand the charge to the PSP (we have an `external_ref`).
- `PENDING` → `CANCELED`: allowed — nothing has been confirmed yet.
- `PROCESSING` → `SUCCEEDED` / `PROCESSING` → `FAILED`: driven only by a verified webhook event.
- `SUCCEEDED`, `FAILED`, `CANCELED` are **terminal** — no transitions out of them in the MVP (refunds, which would move out of `SUCCEEDED`, are a stretch goal).

**Invalid transitions** (must be rejected by the Payment Service, logged, and alerted on — these indicate a bug or an attack, not normal operation):
- Any transition *out of* a terminal state (`SUCCEEDED → FAILED`, `FAILED → SUCCEEDED`, `CANCELED → anything`).
- `PENDING → SUCCEEDED/FAILED` directly (must pass through `PROCESSING` — skipping it means we never recorded the PSP handoff).
- `PROCESSING → CANCELED` (once handed to the PSP, we can no longer unilaterally cancel — the PSP has to tell us the outcome).
- Transitioning a payment that doesn't exist, or a duplicate transition to the *same* state from a stale/duplicate webhook (not an error — this is the dedup case: detect and no-op, don't throw).

The state machine lives in one place (Payment Service) and every caller — API routes, webhook processor, reconciliation — goes through it. No code outside it is allowed to `UPDATE payments SET status = ...` directly; that's what keeps "only valid transitions happen" actually true instead of aspirational.

## 7. Major APIs

| Method & Path | Purpose |
|---|---|
| `POST /payments` | Create a payment. Requires `Idempotency-Key` header. |
| `GET /payments/:id` | Fetch a payment's current state. |
| `GET /payments` | List/filter payments (by status, date range). |
| `POST /payments/:id/cancel` | Cancel a `PENDING` payment. |
| `GET /payments/:id/events` | Fetch the audit trail for a payment. |
| `POST /webhooks/psp` | Receive a webhook from the (mocked) PSP. HMAC-signed. |
| `POST /reconciliation/run` | Manually trigger a reconciliation pass. |
| `GET /reconciliation/runs/:id` | Fetch a reconciliation report. |
| `GET /healthz` | Liveness/readiness for Docker/orchestration. |

## 8. How idempotency should work

Client-facing idempotency protects against **duplicate `POST /payments` calls** (double-click, client retry after timeout, etc.):

1. Client sends `Idempotency-Key: <uuid>` header with every `POST /payments`.
2. Server computes a hash of the request body. In one DB transaction:
   - Try to `INSERT` a row into `idempotency_keys` with `(key, request_hash, status='in_progress')`, relying on a **unique constraint on `key`** to catch races.
   - If the insert succeeds → this is a new request. Proceed to create the payment.
   - If the insert fails on conflict → a row already exists for this key:
     - If `request_hash` matches and `status = 'completed'` → return the **stored response** verbatim (same status code, same body). This makes retries safe and transparent.
     - If `request_hash` matches and `status = 'in_progress'` → another request with the same key is still being processed concurrently; return `409 Conflict` ("retry shortly") rather than racing it.
     - If `request_hash` differs → the client reused a key for a *different* payload, which is a client bug → `422 Unprocessable Entity`.
3. Once the payment is created, update the `idempotency_keys` row to `status='completed'` with the response body/status, in the **same transaction** that creates the payment row — so a crash between "create payment" and "record the idempotency response" is impossible; it's atomic.

This is the standard Stripe-style idempotency pattern. The key design point for the "why": the unique constraint is what makes it safe under *concurrent* duplicate requests, not just sequential retries — a plain "check then insert" without the constraint has a race window.

## 9. How webhook processing and deduplication should work

1. **Receive**: `POST /webhooks/psp` arrives with a signed payload (HMAC over the raw body using a shared secret). Verify the signature *before* touching the database — an invalid signature is rejected with `400` and never persisted.
2. **Deduplicate on arrival**: every PSP event carries a `provider_event_id`. `INSERT ... ON CONFLICT (provider_event_id) DO NOTHING` into `webhook_events`. If the insert affected 0 rows, the event is a redelivery we've already seen — return `200 OK` immediately (so the PSP stops retrying) without reprocessing.
3. **Process asynchronously, not inline**: the HTTP handler's job is just "verify, dedup, persist the raw event, return 200 fast." A separate worker picks up `status='received'` rows and applies them. This matters because PSPs enforce tight webhook response timeouts (e.g. a few seconds) and retry aggressively on timeout/5xx — doing slow business logic inline risks timeouts that *cause* the duplicate deliveries you're trying to avoid.
4. **Apply the event**: the worker loads the payment by `external_ref`, calls the Payment Service's transition function. The transition function itself must be idempotent against *replays that got past dedup* (e.g., dedup table was cleared, or two different event ids somehow describe the same outcome) — transitioning into the same state the payment is already in is a no-op, not an error; transitioning into a state inconsistent with history (§6 invalid transitions) is logged as an anomaly for reconciliation to catch, not silently swallowed.
5. **Out-of-order delivery**: webhooks aren't guaranteed to arrive in the order they were generated. Each PSP event should carry a sequence/version number (or at minimum a timestamp); if an incoming event is older than the payment's current recorded event sequence, it's stale — record it in the audit log but don't regress the state.
6. **Retry on processing failure**: if applying the event throws (DB hiccup, transient error), increment `webhook_events.attempts`, leave `status='received'`, and let the worker retry later with exponential backoff. After a max attempt count, flip to `status='dead_letter'` and surface it — never silently drop a failed webhook.

## 10. How reconciliation should work

Reconciliation exists because steps 1–9 can still leave drift — a webhook that silently dead-lettered, a bug in the state machine, a payment that the PSP considers settled but we never heard about because of an infrastructure outage on our side.

1. **Scheduled job** (e.g. hourly) pulls all `psp_ledger` rows updated since the last successful run, and all `payments` updated in the same window, matched by `external_ref`.
2. For each matched pair, check:
   - **Status mismatch**: our `status` doesn't correspond to the PSP's status (e.g. we show `PROCESSING`, PSP shows settled/succeeded → we missed or haven't yet processed a webhook).
   - **Amount/currency mismatch**: integrity issue, should basically never happen but must be checked.
   - **Orphan on our side**: a payment we created that the PSP has no record of after a reasonable grace period (charge call may have failed silently).
   - **Orphan on PSP side**: PSP has a charge we have no payment row for (shouldn't happen if we always create the payment before calling the PSP, but worth checking — it'd indicate a serious bug).
3. Write a `reconciliation_runs` row with every discrepancy found (not just a count) — the report is the actual deliverable, since a human (or a follow-up automated job) needs to act on each mismatch.
4. **The job itself must be idempotent and safe to re-run**: it only *reads* `payments`/`psp_ledger` and *writes* a new `reconciliation_runs` report — it never mutates payment state directly. Fixing a discrepancy is a separate, deliberate action (possibly manual in the MVP), not something the reconciliation job does automatically — auto-"fixing" financial state from a diff is exactly the kind of silent-bug risk this project is trying to teach you to avoid.

## 11. Important failure scenarios and edge cases

- **Duplicate webhook delivery** (PSP's own retry logic re-sends an event we already processed) → caught by `provider_event_id` dedup (§9).
- **Webhook arrives before the API's "create payment" transaction commits** (race: PSP calls back faster than we finish writing locally) → webhook processor should tolerate "payment not found yet" with a short retry/backoff rather than dead-lettering immediately.
- **Client retries `POST /payments` without an idempotency key, or with a fresh key for what's really the same intent** → by design, this *will* create a duplicate payment; it's a client-side responsibility to reuse the key. Worth calling out explicitly as a documented limitation, not a bug.
- **Concurrent requests with the same idempotency key** (double-click) → handled by the unique constraint + `in_progress`/`completed` states (§8), not by a naive read-then-write check.
- **Network timeout calling the (mock) PSP to initiate a charge** → ambiguous outcome: charge may or may not have gone through on their side. Must not assume failure and silently retry (risk of double charge) — leave the payment `PENDING`/`PROCESSING` and let the webhook (or reconciliation, as a backstop) resolve the true outcome.
- **Out-of-order or stale webhook events** → sequence/timestamp check (§9.5) prevents regressing a terminal state.
- **Webhook signature invalid / malformed payload** → reject before persisting; log for security monitoring (could indicate a spoofing attempt).
- **Worker crash mid-processing** → because the handler commits dedup-insert and state-transition in the same DB transaction, a crash can't leave a "processed but not recorded" half-state; worst case the event is retried, which is safe because the transition is idempotent.
- **Reconciliation finds a mismatch with no clear automatic resolution** → surfaced in the report for manual review rather than auto-corrected (§10).
- **Clock skew** between app and database affecting ordering logic → prefer DB-generated timestamps (`now()` in Postgres) over app-generated ones for anything ordering-sensitive.

## 12. Recommended technology stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript + Node.js | Already the existing scaffold; strong typing helps model the state machine and DB rows precisely. |
| HTTP framework | Express | Already in place; no reason to switch for this project's needs. |
| Database | PostgreSQL | Real transactional guarantees (`BEGIN`/`COMMIT`), unique constraints for idempotency/dedup — this project is *about* those guarantees, so a real RDBMS is non-negotiable (not SQLite, not a NoSQL store). |
| DB access | `node-postgres` (`pg`) with hand-written SQL and explicit transactions, plus a lightweight migration tool (`node-pg-migrate`) | An ORM's auto-managed transactions would hide exactly the mechanics (`BEGIN`, row locking, `ON CONFLICT`) this project exists to demonstrate. Writing raw SQL for the handful of queries involved is not meaningfully more code, and it's far more educational. |
| Validation | Zod | Parses/validates request bodies and gives you static types for free. |
| Background processing | Start with **DB-polling worker** (a `status` column + a `SELECT ... FOR UPDATE SKIP LOCKED` poll loop) for webhook retries and reconciliation scheduling. | No new infrastructure (Redis/queue broker) needed for MVP scale, and `FOR UPDATE SKIP LOCKED` is itself a useful transactional concept to learn. Upgrading to BullMQ+Redis is a clean, well-scoped stretch goal (§ roadmap) once the simpler version works. |
| Testing | Vitest + Supertest, run against a real Postgres (via Docker in CI / Testcontainers locally) | Integration tests against a real database catch the transaction/constraint bugs that mocked-DB unit tests can't. |
| Containerization | Docker + docker-compose (app + Postgres) | Matches the "Docker" requirement and makes the project runnable by anyone with zero setup. |
| API docs | OpenAPI 3 spec (hand-written or generated from Zod schemas via `zod-to-openapi`), served via Swagger UI | Concrete, inspectable contract; satisfies the "API documentation" requirement without a heavy doc-generation pipeline. |

## 13. Development roadmap

1. **Phase 0 — Foundations**: Docker Compose (app + Postgres), migration tooling, `.env` config, health check endpoint.
2. **Phase 1 — Core payment flow**: `payments` table, state machine in the Payment Service, `POST /payments` + `GET /payments/:id`, idempotency keys end-to-end.
3. **Phase 2 — Mock PSP + webhooks**: PSP simulator (accepts charge, later calls back), `webhook_events` table + dedup, webhook signature verification, inline-then-async processing.
4. **Phase 3 — Audit log**: `payment_events` table, every transition writes one, `GET /payments/:id/events`.
5. **Phase 4 — Retry handling**: move webhook processing to the DB-polling worker, backoff + max-attempts + dead-letter.
6. **Phase 5 — Reconciliation**: `psp_ledger` table, scheduled/triggerable reconciliation job, discrepancy reports.
7. **Phase 6 — Tests**: integration tests per phase above against a real Postgres instance (idempotency races, dedup, invalid transitions, reconciliation mismatches).
8. **Phase 7 — Docs & polish**: OpenAPI spec + Swagger UI, README with architecture diagram and "how to run" instructions.
9. **Stretch goals** (after MVP is solid): real Stripe test-mode integration, refunds/partial captures, BullMQ+Redis worker upgrade, multi-tenant merchants.

---

*No application code has been written yet. This document is the basis for discussion before implementation begins.*
