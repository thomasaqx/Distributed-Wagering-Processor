import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessageSchema } from "../../src/infrastructure/database/schemas/messaging.schema";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { initTestOrm, resetDatabase } from "./support/database";
import { createTestSqs, createTestStandardQueue, drainQueue } from "./support/sqs";

const { sqs, queues } = createTestSqs();

async function insertPendingOutboxRows(orm: MikroORM, count: number): Promise<string[]> {
  const em = orm.em.fork();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    em.create(OutboxMessageSchema, {
      id,
      aggregateId: crypto.randomUUID(),
      eventType: "WalletBalanceChanged",
      payload: { eventId: id, eventType: "WalletBalanceChanged" },
      occurredAt: new Date(Date.now() - 1_000),
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1_000),
      publishedAt: null,
    });
  }
  await em.flush();
  return ids;
}

async function runUntilEmpty(publisher: OutboxPublisher): Promise<void> {
  while ((await publisher.publishDueBatch()) > 0) {
    // keep claiming batches until this publisher finds nothing left
  }
}

describe("outbox publisher", () => {
  let orm: MikroORM;
  let eventsQueue: { name: string; url: string };
  const publisher = () => new OutboxPublisher(orm, sqs, queues, eventsQueue.name);

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    eventsQueue = await createTestStandardQueue(sqs, "test-wallet-events");
  });

  it("publishes rows committed by a crashed instance once another instance runs", async () => {
    const ids = await insertPendingOutboxRows(orm, 5);

    await runUntilEmpty(publisher());

    const messages = await drainQueue(sqs, eventsQueue.url, ids.length);
    const published = messages.map((message) => (JSON.parse(message.Body ?? "{}") as { eventId: string }).eventId);
    expect(new Set(published)).toEqual(new Set(ids));
  });

  it("lets two concurrent publishers share the outbox without losing events", async () => {
    const ids = await insertPendingOutboxRows(orm, 60);

    await Promise.all([
      runUntilEmpty(publisher()),
      runUntilEmpty(publisher()),
    ]);

    const unpublished = await orm.em.fork().count(OutboxMessageSchema, { publishedAt: null });
    expect(unpublished).toBe(0);

    const messages = await drainQueue(sqs, eventsQueue.url, ids.length);
    const eventIds = messages.map((message) => (JSON.parse(message.Body ?? "{}") as { eventId: string }).eventId);
    // At-least-once: every event arrives; SKIP LOCKED means no row is claimed by both publishers.
    expect(new Set(eventIds)).toEqual(new Set(ids));
    expect(eventIds.length).toBe(ids.length);
  });
});
