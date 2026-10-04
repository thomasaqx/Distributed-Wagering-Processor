import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const metrics = {
  transactions: new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions by kind, resulting status and entry channel",
    labelNames: ["kind", "status", "source"] as const,
    registers: [metricsRegistry],
  }),
  idempotentReplays: new Counter({
    name: "wager_idempotent_replays_total",
    help: "Duplicate submissions answered from the stored result",
    labelNames: ["source"] as const,
    registers: [metricsRegistry],
  }),
  idempotencyConflicts: new Counter({
    name: "wager_idempotency_conflicts_total",
    help: "Same idempotency key submitted with a different payload",
    registers: [metricsRegistry],
  }),
  inboxDuplicates: new Counter({
    name: "sqs_inbox_duplicates_total",
    help: "SQS messages already recorded in the inbox (redeliveries)",
    registers: [metricsRegistry],
  }),
  sqsRetries: new Counter({
    name: "sqs_message_retries_total",
    help: "SQS messages left for redelivery after a transient failure",
    registers: [metricsRegistry],
  }),
  sqsDeadLettered: new Counter({
    name: "sqs_dead_lettered_messages_total",
    help: "SQS messages sent to the DLQ by this consumer",
    labelNames: ["reason"] as const,
    registers: [metricsRegistry],
  }),
  lockConflicts: new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Wallet lock timeouts and unique-constraint races resolved after rollback",
    labelNames: ["type"] as const,
    registers: [metricsRegistry],
  }),
  outboxLagSeconds: new Gauge({
    name: "outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox message, measured by the publisher",
    registers: [metricsRegistry],
  }),
  outboxPublished: new Counter({
    name: "outbox_published_total",
    help: "Outbox messages published to SQS",
    registers: [metricsRegistry],
  }),
  outboxPublishFailures: new Counter({
    name: "outbox_publish_failures_total",
    help: "Outbox publish attempts that failed and were rescheduled",
    registers: [metricsRegistry],
  }),
  referenceRetries: new Counter({
    name: "pending_reference_retries_total",
    help: "PENDING_REFERENCE transactions retried by the worker",
    labelNames: ["outcome"] as const,
    registers: [metricsRegistry],
  }),
  reconciliationDivergences: new Counter({
    name: "reconciliation_divergences_total",
    help: "Reconciliations where the stored balance differs from the ledger",
    registers: [metricsRegistry],
  }),
  processingDuration: new Histogram({
    name: "wager_processing_duration_seconds",
    help: "End-to-end processing time of a wager transaction",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metricsRegistry],
  }),
};
