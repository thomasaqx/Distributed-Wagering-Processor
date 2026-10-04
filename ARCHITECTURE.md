# Architecture

This document explains how the service keeps money correct under duplicates, out-of-order delivery and concurrent instances, and why each decision was made. Setup and commands are in [README.md](README.md).

## 1. Layers

```
            HTTP (NestJS controllers)              SQS consumer (wager-transactions.fifo)
                       │                                         │
                       └──────────────┬──────────────────────────┘
                                      ▼
   application/   ProcessWagerTransaction · CreateWallet · WalletQueries · ReconcileWallet · RetryPendingReferences
                                      │  one SQL transaction per command
                                      ▼
   domain/        Money · Wallet · WalletLedgerEntry · WagerTransaction · settleWagerTransaction · events
                                      │  pure TypeScript, no ORM / NestJS imports
                                      ▼
   infrastructure/ repositories + mappers (MikroORM EntitySchema) ─► PostgreSQL
                   outbox publisher ─► SQS wallet-events
```

- **Domain** holds every business rule and invariant. Classes have private constructors, `create`/`open` factories that validate, and `rehydrate` factories that rebuild persisted state without re-validating it. It imports nothing from MikroORM or NestJS, so it is unit-tested in milliseconds.
- **Application** orchestrates one use case inside one database transaction. HTTP and SQS call the *same* `ProcessWagerTransaction`.
- **Infrastructure** adapts the outside world: persistence, transport, workers, logging, metrics.

Persistence uses MikroORM `EntitySchema`s describing plain *record* types (`WalletRecord`, ...) and small mappers to and from domain objects. The domain never sees ORM entities.

## 2. Life of a wager transaction

`ProcessWagerTransaction.execute`, in a single SQL transaction:

1. `SET LOCAL lock_timeout = '5s'`.
2. **SQS only:** insert `(consumer_name, message_id)` into `inbox_messages` with `ON CONFLICT DO NOTHING`. No row inserted means a redelivery of a message whose transaction already committed: answer with the stored result.
3. **Lock the wallet:** `SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`). Unknown wallet → `404 WALLET_NOT_FOUND`.
4. **Idempotency:** look up the `Idempotency-Key`. Same key and same payload hash → replay of the stored result with `idempotentReplay: true`. Same key with a different hash → `409`. The same `(providerId, externalTransactionId)` under another key → `409`.
5. Build the `WagerTransaction` (born `PENDING`), resolve the reference by `(providerId, referenceExternalTransactionId)` if any, and check whether that reference was already reversed.
6. **Settle** with the pure domain function `settleWagerTransaction`: it moves the wallet balance through `Wallet.debit/credit` (which return the ledger entry) and moves the transaction to `PROCESSED`, `REJECTED` or `PENDING_REFERENCE`.
7. Persist the transaction row, the wallet's new balance and version, the ledger entry and the integration events into `outbox_messages`.
8. Commit. For SQS, the message is deleted only after the commit.

All writes happen in one transaction, so a crash at any point leaves either everything or nothing.

## 3. ORM and Money mapping

**MikroORM 7** (preferred option of the challenge): explicit Unit of Work, `em.transactional()`, `LockMode` for `FOR UPDATE` / `FOR UPDATE SKIP LOCKED`.

- Migrations are **hand-written SQL** run by MikroORM's Migrator (`bun run migration:up|down`). The schema relies on CHECK constraints, a partial unique index and a trigger, which the ORM's schema diff cannot express. Migrations are listed explicitly in the config (no glob discovery), which behaves the same under Bun and in the Docker image.
- **Money** is a `decimal.js` value object; `number` is never used for money, not even in tests. Amounts travel as decimal strings with exactly two places (`"25.00"`) and are stored as `NUMERIC(20,2)` plus a separate `CHAR(3)` currency column. The pg driver returns `NUMERIC` as strings, which go straight back into `Money.from`, so values are never converted to floating point. Ledger sums for reconciliation are computed by PostgreSQL in `NUMERIC`.
- Input amounts must match `^\d+\.\d{2}$`: this rejects `NaN`, `Infinity`, scientific notation, empty strings, negatives and more than two decimals. `"25"` and `"25.5"` are rejected rather than normalized, so a provider's value is never silently reinterpreted.

## 4. Transactions and locking

**Pessimistic lock per wallet.** Each command locks exactly one wallet row with `SELECT ... FOR UPDATE` for the duration of its transaction. Different wallets never contend; operations on the same wallet run one at a time, across any number of instances, because the lock lives in PostgreSQL. There is no global lock and no in-memory lock.

Why pessimistic rather than optimistic: wagering has hot wallets (one player, many concurrent bets). With optimistic locking every conflict becomes a retry loop with backoff, and the retry limit becomes a correctness and latency knob. A row lock queues the competing transactions at the database, and each one sees the committed balance of the previous one. `version` is still kept: it starts at 1 and increases only when the balance changes, which makes concurrent modifications visible in events and audits.

- `lock_timeout = 5s` turns a stuck lock holder into a retryable `503`, counted in `wallet_lock_conflicts_total{type="lock_timeout"}`, instead of a hung request.
- **Lock order.** Request path: wallet. Pending-reference worker: pending transaction row (`SKIP LOCKED`), then wallet. The request path never locks pending rows, so no deadlock cycle exists.
- **Database as the last barrier.** Even if application logic were wrong, the schema rejects negative balances, duplicate keys, unbalanced ledger rows and double reversals (see §11). A unique violation rolls the transaction back, and the use case re-reads what the winner committed and answers with a replay or a conflict.
- SQS FIFO ordering and deduplication are treated as optimizations only; correctness never depends on them.

## 5. Idempotency

- The `Idempotency-Key` header is mandatory and is the source of truth; the recommended format is `"{providerId}:{externalTransactionId}"`. For SQS it is `data.idempotencyKey`.
- **Payload hash:** SHA-256 (hex) of the canonical JSON of the business fields `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`. Canonical means keys sorted recursively and `undefined` fields omitted. Headers, `messageId` and other transport metadata are not part of the hash, so the same operation sent over HTTP or SQS has the same hash.
- It is persisted in PostgreSQL (`wager_transactions.idempotency_key` UNIQUE), never in memory.
- **Replay** returns the original result: status, failure code and the **balance observed when it was processed** (`observed_balance` column), plus `idempotentReplay: true`.
- The duplicate check runs **after** taking the wallet lock. Fifty identical concurrent requests therefore queue on the lock, and the 2nd to 50th find the 1st one's committed row: one debit, 49 replays, no exceptions. The unique constraint still covers the case where the same key targets different wallets.
- **SQS inbox:** `(consumer_name, message_id)` primary key, written in the same transaction as the financial change. A worker that dies after commit and before `DeleteMessage` causes a redelivery, which becomes a replay.

## 6. Transaction status transitions

```
PENDING ──► PROCESSED            (terminal)
   │   └──► REJECTED             (terminal, carries failureCode)
   │   └──► FAILED               (terminal)
   └──────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

Transitions are methods on `WagerTransaction` (`markProcessed`, `reject`, `markPendingReference`, `fail`). Each first asserts the current state is not terminal; touching a terminal transaction throws `InvalidTransactionStateError`, because that would be a programming error, not a business path. `FAILED` exists in the model and the schema, but the current flows never produce it: permanent infrastructure problems are handled at the transport level (DLQ) instead of being persisted (see §13).

## 7. Business rules

| Kind | Balance | Ledger | Rule |
|---|---|---|---|
| `OPENING` | credit | CREDIT | internal only, created with the wallet in the same transaction; rejected (`400`) if sent over HTTP or SQS |
| `BET` | debit | DEBIT | rejected with `INSUFFICIENT_FUNDS` when the balance would go negative |
| `WIN` | credit | CREDIT | may reference the round's BET |
| `LOSS` | none | none | records the outcome; the only kind allowed to carry `0.00` |
| `REFUND` | credit | CREDIT | must reference a PROCESSED BET of the same provider, player, wallet, currency and round, with the same amount |
| `ROLLBACK` | inverse of reference | inverted | references a PROCESSED BET, WIN or REFUND; a BET rollback credits, a WIN/REFUND rollback debits |

A rejected transaction never changes the balance and never creates a ledger entry. A rollback that would overdraw is rejected with `REVERSAL_WOULD_OVERDRAW`, distinct from a BET without funds.

**Interpretations** (where the statement leaves room):

- **A reference can be reversed once in total.** The statement requires "once per kind of operation", which the partial unique index `(reference_transaction_id, kind) WHERE status = 'PROCESSED'` enforces. The application is stricter: once a BET was refunded it cannot also be rolled back, and vice versa, since that would credit the same stake twice. This is checked under the wallet lock, so it cannot race.
- A `WIN` or `LOSS` with `referenceExternalTransactionId` follows the same reference resolution (pending, mismatch, kind checks); without it they settle immediately.
- `WALLET_NOT_FOUND` is not persisted: a transaction row needs an existing wallet (foreign key). HTTP answers `404`; the SQS consumer logs it and acks.
- A `PENDING_REFERENCE` response reports the wallet's current balance, since nothing has been applied yet.

## 8. Failure codes

Stable, machine-readable values in `failureCode` of `REJECTED` transactions (HTTP `422`, `WagerTransactionRejected` event):

| Code | Meaning | Provider action |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET larger than the balance | do not retry |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK of a WIN/REFUND would make the balance negative | escalate / reconcile manually |
| `CURRENCY_MISMATCH` | money currency differs from the wallet currency | fix payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` does not own `walletId` | fix payload |
| `REFERENCE_NOT_FOUND` | referenced transaction never arrived within the retry window | send the reference, then a new reversal |
| `REFERENCE_MISMATCH` | reference belongs to another wallet, player, currency or round | fix payload |
| `INVALID_REFERENCE_KIND` | e.g. REFUND of a WIN, ROLLBACK of a LOSS | fix payload |
| `REFERENCE_NOT_PROCESSED` | the referenced transaction was itself rejected | do not retry |
| `ALREADY_REVERSED` | reference already refunded or rolled back | do not retry |
| `AMOUNT_MISMATCH` | reversal amount differs from the reference amount (partial reversals are out of scope) | fix payload |

`WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`, `INVALID_REQUEST` and `TEMPORARILY_UNAVAILABLE` are API error codes (`404`, `409`, `400`, `503`), not transaction states.

## 9. HTTP status mapping

The same mapping is used by every endpoint, and replays answer with the status of the original request.

| Status | Situation | Can the provider resend the same request? |
|---|---|---|
| `200` | processed (or replay) | yes, same answer |
| `201` | wallet created | – |
| `202` | `PENDING_REFERENCE` | yes, same answer until settled |
| `400` | invalid payload / unknown field / missing header | no, fix it |
| `404` | wallet or transaction not found | no |
| `409` | idempotency conflict / duplicate wallet | no |
| `413` | body over 16 KB | no |
| `422` | business rejection with `failureCode` | yes, same answer (it is persisted) |
| `503` | database unavailable or wallet lock timeout | **yes, retry with backoff** |

Errors share one body shape, `{"error":{"code":"...","message":"..."}}`. Stack traces never leave the process (`HttpExceptionFilter`).

## 10. SQS consumer, retries and DLQ

`wager-transactions.fifo` → `WagerQueueConsumer` → the same `ProcessWagerTransaction` as HTTP.

| Outcome | Classification | Action |
|---|---|---|
| processed / rejected / pending / replay | success or business result | `DeleteMessage` **after** commit |
| `WALLET_NOT_FOUND` | business | log + delete |
| malformed JSON, schema violation, `OPENING`, idempotency conflict | permanent | copy to `wager-transactions-dlq.fifo` with a `reason` attribute, then delete |
| anything else (database down, lock timeout, bug) | transient | keep the message; `ChangeMessageVisibility` to `2s × 2^(receiveCount-1)` (capped at 300 s) |

After `maxReceiveCount = 5` receives, SQS's redrive policy moves a still-failing message to the DLQ. Messages are handled one at a time per batch, which preserves per-wallet FIFO order (`MessageGroupId` = wallet id).

**SIGTERM:** NestJS shutdown hooks run before the database pool closes (`beforeApplicationShutdown`). The consumer stops polling, aborts the in-flight long poll, finishes the message being processed, and returns the rest of the batch to the queue with `VisibilityTimeout = 0`. The outbox publisher and the pending-reference worker finish their current transaction and stop.

## 11. Schema guarantees

Enforced by PostgreSQL, independently of application code (`Migration20261002120000InitialSchema`):

| Guarantee | Mechanism |
|---|---|
| one wallet per player and currency | `UNIQUE (player_id, currency)` |
| non-negative balance, `version >= 1` | `CHECK` |
| unique idempotency key; unique `(provider_id, external_transaction_id)` | `UNIQUE` |
| at most one ledger entry per transaction | `UNIQUE (transaction_id)` |
| ledger arithmetic `balance_after = balance_before ± amount`, `amount > 0`, balances `>= 0` | `CHECK` |
| ledger immutability | `BEFORE UPDATE OR DELETE` trigger raising an exception |
| a reference reversed once per reversal kind | partial `UNIQUE (reference_transaction_id, kind) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| REFUND/ROLLBACK carry a reference; REJECTED/FAILED carry a failure code | `CHECK` |
| inbox dedupe | `PRIMARY KEY (consumer_name, message_id)` |
| valid enums (kind, status, direction, event type) | `CHECK ... IN (...)` |

The ledger has a `sequence` identity column used for ordering and keyset pagination. Timestamps can tie; the sequence cannot.

## 12. Transactional outbox

Integration events are written to `outbox_messages` in the same transaction as the financial change, so an event exists if and only if its change committed. Events are subclasses of an abstract `IntegrationEvent<T>` with `eventType` and `version` fixed on the type; payloads carry `MoneyProps` strings, never `Money` instances.

| Event | Emitted when |
|---|---|
| `WagerTransactionProcessed` | any transaction applied, including `LOSS` and `OPENING` |
| `WagerTransactionRejected` | business rejection |
| `WalletBalanceChanged` | only when the balance changed |
| `WagerTransactionPendingReference` | reference missing (once, on arrival) |

`OutboxPublisher` (every instance runs one) claims due rows with `FOR UPDATE SKIP LOCKED`, sends them to the `wallet-events` queue and marks them published in the same transaction. On a send failure the row is rescheduled with exponential backoff (1 s, 2 s, 4 s, ... capped at 5 min). Concurrent publishers never claim the same row. If an instance dies after sending and before committing, the row is published again later: delivery is **at-least-once**, and consumers deduplicate by `eventId`. `outbox_lag_seconds` exposes the age of the oldest unpublished row.

## 13. Out-of-order references

A `REFUND`/`ROLLBACK` (or a referencing `WIN`/`LOSS`) whose reference is unknown is stored as `PENDING_REFERENCE` (`202`). `RetryPendingReferences` claims one due row at a time with `FOR UPDATE SKIP LOCKED`, locks the wallet and re-runs the same settlement rules. Retries back off exponentially from 2 s up to 60 s; after **10 attempts (about 6 minutes)** the transaction is `REJECTED` with `REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event is published. The window is long enough to absorb broker reordering and provider retries, and short enough for the provider to get a definitive answer in the same session. All values are configurable (`PENDING_REFERENCE_*`).

## 14. Reconciliation

`POST /wallets/:id/reconciliation` reads, in one `REPEATABLE READ` snapshot, the stored balance and `SUM(credits) - SUM(debits)` of the ledger, both computed in `NUMERIC`. A difference is logged (`warn`), counted (`reconciliation_divergences_total`) and returned with `consistent: false`. It is **never corrected automatically**: overwriting either side would destroy the evidence needed to investigate.

## 15. Observability

- **Logs:** pino JSON on stdout. Every wager log line carries `correlationId` (from `X-Correlation-Id` or generated; the `messageId` for SQS), `messageId`, `transactionId`, `walletId`, `providerId`, kind, status and failure code. No full payloads, no secrets.
- **Metrics** (`GET /metrics`): `wager_transactions_total{kind,status,source}`, `wager_idempotent_replays_total`, `wager_idempotency_conflicts_total`, `sqs_inbox_duplicates_total`, `sqs_message_retries_total`, `sqs_dead_lettered_messages_total{reason}`, `wallet_lock_conflicts_total{type}`, `outbox_lag_seconds`, `outbox_published_total`, `outbox_publish_failures_total`, `pending_reference_retries_total{outcome}`, `reconciliation_divergences_total`, `wager_processing_duration_seconds{source}`, plus process defaults.
- **Health:** `/health/live` (process up) and `/health/ready` (`SELECT 1` on PostgreSQL and `GetQueueUrl` on SQS; `503` when either is down).

## 16. Authentication

Not implemented, by decision: authentication carries no points, and the time went into correctness. The extension point is explicit: `AuthGuard` (no-op) is applied to every business controller. The intended design:

- an external IdP (Keycloak) with one OAuth2 client per game provider (client-credentials grant);
- the guard validates the bearer JWT (signature via JWKS, `iss`, `aud`, `exp`) and maps the token's client to a `providerId`;
- requests whose body `providerId` differs from the token's provider are rejected with `403`;
- health and metrics stay open, and SQS messages are an internal trusted channel, but their `providerId` still goes through the same domain validation.

## 17. Security basics

Strict input whitelist (zod `strictObject`: unknown fields → `400`; UUIDs, enums and string lengths validated) · parameterized queries only (ORM or `?` placeholders) · 16 KB body limit · no stack traces in responses · configuration through environment variables (`.env.example`), no secrets committed · `OPENING` rejected on both entry channels · the container runs as a non-root user.

## 18. Trade-offs and known limitations

- **Application services use concrete repositories** bound to the transaction's `EntityManager`, with no repository interfaces or generic base repository. This means fewer abstractions to read. The boundary that matters, a framework-free domain, is kept; swapping the database would touch the repositories and the use cases' wiring.
- **Throughput on a single hot wallet is serialized** by design. Different wallets scale with instances and connections.
- **MiniStack instead of LocalStack:** `localstack/localstack` requires an auth token since 2026-03, which would break `docker compose up` for reviewers. MiniStack (MIT, pinned `1.5.20`) is allowed by the challenge and API-compatible on port 4566. It keeps queues in memory: if the `sqs` container restarts, queues disappear until `sqs-init` runs again (`docker compose up sqs-init`).
- **`TRUNCATE` is not blocked** on the ledger (only `UPDATE`/`DELETE`), so integration tests can reset state. In production the application role would not be granted `TRUNCATE`.
- **Pending references are polled**, not triggered by the arrival of the referenced transaction: a pending reversal settles on the worker's next attempt (2 s at first), not instantly.
- **Outbox events are at-least-once and not globally ordered** (`wallet-events` is a standard queue). Ordering per wallet can be rebuilt from `walletVersion` in `WalletBalanceChanged`.
- **Partial reversals, multiple currencies in practice, double-entry bookkeeping, load testing and OpenTelemetry** are out of scope. The model is multi-currency and currency conflicts are tested, but only BRL is exercised.
- `FAILED` is modeled but not produced (see §6).
- No authentication (see §16).

## 19. Decision log

| Decision | Why | Trade-off |
|---|---|---|
| MiniStack (pinned) as SQS emulator | LocalStack image needs an auth token since 2026-03; MiniStack is allowed and token-free | less battle-tested; the database, not the broker, guarantees invariants |
| Hand-written SQL migrations via MikroORM Migrator, explicit list | constraints/trigger/partial index cannot be generated; deterministic under Bun | every schema change written by hand |
| Ledger immutability by trigger | must hold even for code or manual SQL that bypasses the app | `TRUNCATE` left open for tests |
| Money input must match `^\d+\.\d{2}$`, rejected not normalized | fixed scale-2 contract; never reinterpret a provider's value | `"25"` / `"25.5"` get `400` |
| Pessimistic `FOR UPDATE` per wallet + `lock_timeout` | hot wallets; no retry loops; correct across instances | same-wallet operations serialized |
| Idempotency check after the wallet lock | concurrent duplicates become replays instead of constraint errors | one lock acquisition even for replays |
| Stricter "reversed once in total" rule | prevents refunding and rolling back the same stake | stricter than the literal statement (documented) |
| Pure `settleWagerTransaction` domain function | all section-7 rules unit-testable without a database | one more file between use case and entities |
| Separate `wagering_test` database and per-run queues for integration tests | tests can run next to a live stack without stealing messages or data | tests create queues on every run |
