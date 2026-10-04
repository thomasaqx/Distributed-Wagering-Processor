import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { LockMode } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { OutboxMessageMapper } from "../database/mappers/outbox-message.mapper";
import { OutboxMessageSchema } from "../database/schemas/messaging.schema";
import { logger } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { PollingLoop } from "../workers/polling-loop";
import { QueueUrlResolver } from "./queue-url.resolver";
import { WALLET_EVENTS_QUEUE } from "./sqs.module";

const BATCH_SIZE = 20;

export const OUTBOX_TARGET_QUEUE = Symbol("OUTBOX_TARGET_QUEUE");
export const defaultOutboxTargetQueue = WALLET_EVENTS_QUEUE;

/**
 * Publishes committed outbox rows to SQS. Rows are claimed with FOR UPDATE SKIP LOCKED, so any
 * number of instances can run this concurrently without blocking each other. If the process dies
 * after sending but before committing, the row is published again later: delivery is
 * at-least-once and consumers deduplicate by eventId.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop = new PollingLoop("outbox-publisher", Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500), () =>
    this.publishDueBatch(),
  );

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrlResolver,
    @Inject(OUTBOX_TARGET_QUEUE) private readonly targetQueue: string,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED !== "false") {
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  async publishDueBatch(): Promise<number> {
    const queueUrl = await this.queues.resolve(this.targetQueue);
    const published = await this.orm.em.fork().transactional(async (em) => {
      const now = new Date();
      const records = await em.find(
        OutboxMessageSchema,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        { orderBy: { occurredAt: "asc" }, limit: BATCH_SIZE, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );

      for (const record of records) {
        const message = OutboxMessageMapper.toDomain(record);
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(message.payload),
              MessageAttributes: {
                eventType: { DataType: "String", StringValue: message.eventType },
                eventId: { DataType: "String", StringValue: message.id },
              },
            }),
          );
          message.markPublished(new Date());
          metrics.outboxPublished.inc();
        } catch (error) {
          message.scheduleRetry(new Date());
          metrics.outboxPublishFailures.inc();
          logger.warn({ eventId: message.id, attempts: message.attempts, err: error }, "outbox publish failed");
        }
        em.assign(record, OutboxMessageMapper.toRecord(message));
      }
      return records.filter((record) => record.publishedAt !== null).length;
    });
    await this.updateLagGauge();
    return published;
  }

  private async updateLagGauge(): Promise<void> {
    const rows = await this.orm.em
      .getConnection()
      .execute<{ lag: string | null }[]>(
        "select extract(epoch from now() - min(occurred_at)) as lag from outbox_messages where published_at is null",
      );
    const lag = rows[0]?.lag;
    metrics.outboxLagSeconds.set(lag === null || lag === undefined ? 0 : Number(lag));
  }
}
