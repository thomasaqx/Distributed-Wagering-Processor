import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type ProcessWagerCommand, ProcessWagerTransaction, type WagerResult } from "../../src/application/process-wager-transaction";
import type { WagerRequest } from "../../src/application/request-schemas";
import { WAGER_CONSUMER_NAME, WagerQueueConsumer } from "../../src/infrastructure/messaging/wager-queue.consumer";
import { initTestOrm, resetDatabase } from "./support/database";
import {
  countLedgerEntries,
  expectLedgerConsistent,
  openWallet,
  type TestWallet,
  wagerRequest,
  waitFor,
  walletBalance,
} from "./support/fixtures";
import { createTestSqs, createTestWagerQueues, receiveOne, sendFifo, type TestWagerQueues } from "./support/sqs";

const { sqs, queues } = createTestSqs();

function queueMessage(messageId: string, request: WagerRequest): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...request, idempotencyKey: `${request.providerId}:${request.externalTransactionId}` },
  });
}

/** Simulates a database outage: every call fails with a transient (non-business) error. */
class UnavailableProcessWager extends ProcessWagerTransaction {
  override execute(_command: ProcessWagerCommand): Promise<WagerResult> {
    return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
  }
}

async function queueDepth(queueUrl: string): Promise<number> {
  const { GetQueueAttributesCommand } = await import("@aws-sdk/client-sqs");
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

describe("SQS consumer, inbox and atomicity", () => {
  let orm: MikroORM;
  let testQueues: TestWagerQueues;
  let wallet: TestWallet;
  const consumerWith = (processWager: ProcessWagerTransaction) =>
    new WagerQueueConsumer(sqs, queues, processWager, {
      queueName: testQueues.queueName,
      deadLetterQueueName: testQueues.deadLetterQueueName,
    });

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    testQueues = await createTestWagerQueues(sqs);
    wallet = await openWallet(orm, "100.00");
  });

  it("does not duplicate effects when the worker dies after commit and before ack", async () => {
    const request = wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "40.00", currency: "BRL" } });
    await sendFifo(sqs, testQueues.queueUrl, queueMessage("msg-1", request), wallet.walletId);

    // First delivery: the transaction commits, then the "process dies" before DeleteMessage.
    const first = await receiveOne(sqs, testQueues.queueUrl);
    await new ProcessWagerTransaction(orm).execute({
      request,
      idempotencyKey: "provider-a:bet-1",
      correlationId: "msg-1",
      source: "sqs",
      inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: "msg-1" },
    });
    expect(first.Body).toBeDefined();

    // Visibility timeout expires, SQS redelivers; the inbox turns it into a replay and it is acked.
    const redelivered = await receiveOne(sqs, testQueues.queueUrl);
    const disposition = await consumerWith(new ProcessWagerTransaction(orm)).handle(testQueues.queueUrl, redelivered);

    expect(disposition).toBe("acked");
    expect(await walletBalance(orm, wallet.walletId)).toBe("60.00");
    expect(await countLedgerEntries(orm, wallet.walletId, "DEBIT")).toBe(1);
    await waitFor(async () => (await queueDepth(testQueues.queueUrl)) === 0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("acks a business rejection instead of retrying it", async () => {
    const request = wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "500.00", currency: "BRL" } });
    await sendFifo(sqs, testQueues.queueUrl, queueMessage("msg-1", request), wallet.walletId);

    const disposition = await consumerWith(new ProcessWagerTransaction(orm)).handle(testQueues.queueUrl, await receiveOne(sqs, testQueues.queueUrl));

    expect(disposition).toBe("acked");
    const rows = await orm.em.fork().execute<{ failure_code: string }[]>("select failure_code from wager_transactions where kind = 'BET'");
    expect(rows[0]?.failure_code).toBe("INSUFFICIENT_FUNDS");
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("sends a malformed message straight to the DLQ", async () => {
    await sendFifo(sqs, testQueues.queueUrl, '{"messageId":"msg-1","type":"WagerTransactionRequested","data":{"kind":"OPENING"}}', "group-1");

    const disposition = await consumerWith(new ProcessWagerTransaction(orm)).handle(testQueues.queueUrl, await receiveOne(sqs, testQueues.queueUrl));

    expect(disposition).toBe("dead-lettered");
    const dead = await receiveOne(sqs, testQueues.deadLetterQueueUrl);
    expect(dead.MessageAttributes?.reason?.StringValue).toBe("malformed");
    expect(await walletBalance(orm, wallet.walletId)).toBe("100.00");
  });

  it("retries transient failures with backoff and lets the redrive policy move the message to the DLQ", async () => {
    const request = wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "10.00", currency: "BRL" } });
    await sendFifo(sqs, testQueues.queueUrl, queueMessage("msg-1", request), wallet.walletId);
    const consumer = consumerWith(new UnavailableProcessWager(orm));

    const dispositions: string[] = [];
    await waitFor(
      async () => {
        const { ReceiveMessageCommand } = await import("@aws-sdk/client-sqs");
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: testQueues.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
        );
        for (const message of Messages) {
          dispositions.push(await consumer.handle(testQueues.queueUrl, message));
        }
        return (await queueDepth(testQueues.deadLetterQueueUrl)) === 1;
      },
      30_000,
      0,
    );

    expect(dispositions.length).toBeGreaterThanOrEqual(2);
    expect(dispositions.every((disposition) => disposition === "retry")).toBe(true);
    expect(await walletBalance(orm, wallet.walletId)).toBe("100.00");
  }, 40_000);

  it("rolls back wallet, transaction, ledger and inbox together when any write fails", async () => {
    // Force the very last write of the transaction (the outbox insert) to fail.
    await orm.em.fork().execute(`
      create or replace function test_fail_outbox() returns trigger language plpgsql as $$
      begin raise exception 'simulated outbox failure'; end; $$;
      create trigger test_fail_outbox before insert on outbox_messages for each row execute function test_fail_outbox();
    `);
    try {
      const request = wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "40.00", currency: "BRL" } });
      const attempt = new ProcessWagerTransaction(orm).execute({
        request,
        idempotencyKey: "provider-a:bet-1",
        correlationId: "msg-1",
        source: "sqs",
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: "msg-1" },
      });

      await expect(attempt).rejects.toThrow(/simulated outbox failure/);
    } finally {
      await orm.em.fork().execute("drop trigger test_fail_outbox on outbox_messages; drop function test_fail_outbox();");
    }

    const counts = await orm.em.fork().execute<{ transactions: string; inbox: string }[]>(
      `select (select count(*) from wager_transactions where kind = 'BET')::text as transactions,
              (select count(*) from inbox_messages)::text as inbox`,
    );
    expect(counts[0]).toEqual({ transactions: "0", inbox: "0" });
    expect(await walletBalance(orm, wallet.walletId)).toBe("100.00");
    expect(await countLedgerEntries(orm, wallet.walletId, "DEBIT")).toBe(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });
});
