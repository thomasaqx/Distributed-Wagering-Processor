# Distributed Wagering Processor

A wallet service that processes wagering transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) sent by multiple game providers over **HTTP** and **AWS SQS**. It stays correct when messages are **duplicated**, arrive **out of order**, or are processed **concurrently by several instances**.

Design decisions, trade-offs and known limitations are in [ARCHITECTURE.md](ARCHITECTURE.md). The original challenge statement lives on the `challenge` branch.

## Stack

Bun 1.4 · TypeScript (strict) · NestJS 11 · PostgreSQL 17 · MikroORM 7 · AWS SQS (MiniStack emulator) · Docker Compose · `decimal.js` · zod · pino · prom-client

## Quick start

Requirements: Docker with Compose v2, and [Bun 1.4+](https://bun.sh) to run tests or the API outside Docker.

```bash
docker compose up --build
```

This starts:

| Service    | What it does                                                                 |
|------------|------------------------------------------------------------------------------|
| `postgres` | PostgreSQL 17                                                                |
| `sqs`      | MiniStack, an SQS-compatible emulator on port 4566                           |
| `sqs-init` | one-shot job: creates `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive after 5 receives) and `wallet-events` |
| `migrate`  | one-shot job: applies database migrations                                    |
| `api`      | the application on <http://localhost:3000>: HTTP API, SQS consumer, outbox publisher and pending-reference worker |

Check that it is ready:

```bash
curl localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Correctness with several instances does not depend on Compose: `test/integration/multi-instance.test.ts` starts three application processes against the same database.

## Commands

| Command                    | Description                                                        |
|----------------------------|--------------------------------------------------------------------|
| `bun install`              | install dependencies                                               |
| `bun run start`            | start the API on the host (uses `.env`, see `.env.example`)        |
| `bun run migration:up`     | apply pending migrations                                           |
| `bun run migration:down`   | revert the latest migration                                        |
| `bun test`                 | unit tests (domain, settlement rules, payload hash), no Docker needed |
| `bun run test:integration` | integration and concurrency tests against real PostgreSQL and SQS  |
| `bun run typecheck`        | TypeScript type check (Bun executes TS without checking types)     |

## Running the tests

```bash
bun install
bun test                                  # 60 unit tests

docker compose up -d postgres sqs sqs-init
bun run test:integration                  # 31 integration / concurrency tests
```

Integration tests never touch the application's data: they create and use a separate `wagering_test` database and SQS queues with random names, so they can run while `docker compose up` is serving traffic. Nothing is mocked: PostgreSQL and SQS are real.

What they cover:

| Area | Tests |
|---|---|
| Schema | constraints reject negative balance, duplicates, invalid enums, unbalanced or mutated ledger rows |
| Concurrency | same BET 50× in parallel → one debit · 100.00 with two concurrent 80.00 BETs → one PROCESSED, one REJECTED, balance 20.00 · 30 BETs on one hot wallet · 10 wallets in parallel · same key + different payload under race · concurrent REFUND/ROLLBACK of one BET |
| Multiple instances | 3 application processes: 100/80/80 across instances · 30 duplicates spread over 3 instances · instance killed with `SIGKILL` mid-load and restarted |
| Messaging | worker dies after commit and before ack → redelivery is a replay · business rejection is acked · malformed message → DLQ · transient failure → retries with backoff → redrive to DLQ · two outbox publishers on the same outbox · outbox rows of a crashed instance published by another |
| Atomicity | failure on the last write rolls back wallet, transaction, ledger and inbox together |
| Out-of-order | REFUND before its BET → `PENDING_REFERENCE` → processed by the worker · reference never arrives → `REJECTED` / `REFERENCE_NOT_FOUND` |

Every test that moves money ends by checking **wallet balance == balance rebuilt from the ledger** through the reconciliation use case. Waits are polling with a timeout, never fixed sleeps.

<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/465552d2-f8b0-49c8-a1fc-f84241e0203e" />

## HTTP API

| Method & path | Description |
|---|---|
| `POST /wallets` | create a wallet; a positive initial balance is recorded as an internal `OPENING` transaction |
| `GET /wallets/:walletId` | wallet and current balance |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | ledger entries, oldest first, opaque cursor |
| `POST /wallets/:walletId/reconciliation` | compare stored balance with the ledger |
| `POST /wagering/transactions` | submit a transaction (`Idempotency-Key` header required) |
| `GET /wagering/transactions/:transactionId` | transaction by internal id |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transaction by provider id |
| `GET /health/live`, `GET /health/ready` | liveness; readiness checks PostgreSQL and SQS |
| `GET /metrics` | Prometheus metrics |

### Example

```bash
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
# {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"<walletId>\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",
       \"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Sending the same request again returns the same body with `"idempotentReplay": true`.

<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/74c9b4cd-e4bb-41f4-a0cb-af81e3bb9ca1" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/0aafc93c-7503-4dfe-ad3a-c7b85419ecd6" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/296eaf5d-933d-4967-8e62-2b1730b13b0c" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/8cc0283f-50c7-463b-b94a-6e2263a9f5eb" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/63cf74ad-6c01-4e8b-8021-6522108dd36e" />

### Status codes

| Status | Meaning | Body |
|---|---|---|
| `200` | transaction processed (or replay of a processed one) | result |
| `201` | wallet created | wallet |
| `202` | accepted, waiting for the referenced transaction (`PENDING_REFERENCE`) | result |
| `400` | invalid payload, unknown field, missing `Idempotency-Key`, `OPENING` submitted | `error.code = INVALID_REQUEST` |
| `404` | wallet or transaction not found | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| `409` | idempotency key reused with a different payload, or duplicate wallet | `IDEMPOTENCY_KEY_CONFLICT` / `WALLET_ALREADY_EXISTS` |
| `413` | body larger than 16 KB | `PAYLOAD_TOO_LARGE` |
| `422` | business rejection, persisted as `REJECTED` | result with `failureCode` |
| `503` | transient infrastructure failure (database down, wallet lock timeout): safe to retry | `TEMPORARILY_UNAVAILABLE` |

Failure codes are listed in [ARCHITECTURE.md](ARCHITECTURE.md#failure-codes).
![Uploading image.png…]()


## SQS input

Publish to `wager-transactions.fifo` (use the wallet id as `MessageGroupId`):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Integration events (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) are published to the `wallet-events` queue through the transactional outbox.

## Project structure

```
src/
  domain/            pure business model: Money, Wallet, WalletLedgerEntry, WagerTransaction,
                     settlement rules, integration events, outbox/inbox messages (no ORM, no NestJS)
  application/       use cases: process a wager transaction, create wallet, queries, reconciliation,
                     pending-reference worker, payload hash, input schemas
  infrastructure/
    database/        MikroORM config, migrations, entity schemas, mappers, repositories
    http/            controllers, error filter, auth extension point, correlation id
    messaging/       SQS client, consumer, outbox publisher
    observability/   JSON logger, Prometheus metrics
    workers/         polling loop shared by background workers
test/integration/    integration, concurrency and multi-instance tests
docker/sqs/          queue bootstrap script
```

## Configuration

All settings come from environment variables; defaults match `docker-compose.yml`. See [.env.example](.env.example). No secrets are committed: the SQS credentials are dummies required by the AWS SDK and ignored by the emulator.
