import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { IdempotencyConflictError, InvalidRequestError, WalletNotFoundError } from "../../application/errors";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import { parseOrThrow, type WagerQueueMessage, wagerQueueMessageSchema } from "../../application/request-schemas";
import { logger } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { QueueUrlResolver } from "./queue-url.resolver";
import { WAGER_TRANSACTIONS_DLQ, WAGER_TRANSACTIONS_QUEUE } from "./sqs.module";

export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

export interface WagerQueueConfig {
  queueName: string;
  deadLetterQueueName: string;
}

export const WAGER_QUEUE_CONFIG = Symbol("WAGER_QUEUE_CONFIG");

export const defaultWagerQueueConfig: WagerQueueConfig = {
  queueName: WAGER_TRANSACTIONS_QUEUE,
  deadLetterQueueName: WAGER_TRANSACTIONS_DLQ,
};

const WAIT_TIME_SECONDS = Number(process.env.SQS_WAIT_TIME_SECONDS ?? 5);
const RETRY_BASE_SECONDS = Number(process.env.SQS_RETRY_BASE_SECONDS ?? 2);
const RETRY_MAX_SECONDS = 300;

export type Disposition = "acked" | "dead-lettered" | "retry";

/**
 * Consumes wager-transactions.fifo through the SAME use case as the HTTP endpoint.
 *
 * - success or business rejection  -> delete (ack), only after the SQL transaction committed
 * - malformed / conflicting payload -> copy to the DLQ with the reason, then delete (permanent)
 * - anything else (DB down, lock timeout, bug) -> keep the message, extend its visibility with
 *   exponential backoff; after maxReceiveCount the queue's redrive policy moves it to the DLQ
 *
 * A crash between commit and delete just causes a redelivery, which the inbox turns into a replay.
 */
@Injectable()
export class WagerQueueConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private receiveAbort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrlResolver,
    private readonly processWager: ProcessWagerTransaction,
    @Inject(WAGER_QUEUE_CONFIG) private readonly config: WagerQueueConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_CONSUMER_ENABLED !== "false") {
      this.running = true;
      this.loopDone = this.loop();
    }
  }

  /** SIGTERM: stop polling, finish the message in flight, give the rest of the batch back to SQS. */
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.receiveAbort.abort();
    await this.loopDone;
    logger.info({ consumer: WAGER_CONSUMER_NAME }, "sqs consumer stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.running) {
          logger.error({ err: error }, "sqs poll failed");
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    }
  }

  /** Receives one batch and handles it in order; returns how many messages were received. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.queues.resolve(this.config.queueName);
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: this.receiveAbort.signal },
    );

    for (const [index, message] of Messages.entries()) {
      if (!this.running) {
        await this.releaseVisibility(queueUrl, Messages.slice(index));
        break;
      }
      await this.handle(queueUrl, message);
    }
    return Messages.length;
  }

  async handle(queueUrl: string, message: Message): Promise<Disposition> {
    let parsed: WagerQueueMessage;
    try {
      parsed = parseOrThrow(wagerQueueMessageSchema, JSON.parse(message.Body ?? ""));
    } catch (error) {
      return this.deadLetter(queueUrl, message, "malformed", error);
    }

    const log = { messageId: parsed.messageId, walletId: parsed.data.walletId, providerId: parsed.data.providerId };
    try {
      const { idempotencyKey, ...request } = parsed.data;
      await this.processWager.execute({
        request,
        idempotencyKey,
        correlationId: parsed.messageId,
        source: "sqs",
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: parsed.messageId },
      });
      await this.ack(queueUrl, message);
      return "acked";
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        logger.warn({ ...log, failureCode: error.code }, "wager message rejected: wallet not found");
        await this.ack(queueUrl, message);
        return "acked";
      }
      if (error instanceof InvalidRequestError || error instanceof IdempotencyConflictError) {
        return this.deadLetter(queueUrl, message, error.code, error);
      }
      return this.retryLater(queueUrl, message, log, error);
    }
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string, error: unknown): Promise<Disposition> {
    const dlqUrl = await this.queues.resolve(this.config.deadLetterQueueName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
      }),
    );
    await this.ack(queueUrl, message);
    metrics.sqsDeadLettered.inc({ reason });
    logger.warn({ sqsMessageId: message.MessageId, reason, err: error }, "wager message sent to DLQ");
    return "dead-lettered";
  }

  private async retryLater(queueUrl: string, message: Message, log: object, error: unknown): Promise<Disposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delay = Math.min(RETRY_BASE_SECONDS * 2 ** (receiveCount - 1), RETRY_MAX_SECONDS);
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }),
    );
    metrics.sqsRetries.inc();
    logger.warn({ ...log, receiveCount, retryInSeconds: delay, err: error }, "wager message will be retried");
    return "retry";
  }

  private async releaseVisibility(queueUrl: string, messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
    }
  }
}
