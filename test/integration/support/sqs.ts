import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { QueueUrlResolver } from "../../../src/infrastructure/messaging/queue-url.resolver";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs.module";

export function createTestSqs(): { sqs: SQSClient; queues: QueueUrlResolver } {
  const sqs = createSqsClient();
  return { sqs, queues: new QueueUrlResolver(sqs) };
}

export interface TestWagerQueues {
  queueName: string;
  deadLetterQueueName: string;
  queueUrl: string;
  deadLetterQueueUrl: string;
}

/**
 * Creates a FIFO queue + DLQ pair private to this test run, with a short visibility timeout and
 * a small maxReceiveCount so redelivery and redrive can be observed in seconds.
 */
export async function createTestWagerQueues(sqs: SQSClient, maxReceiveCount = 2): Promise<TestWagerQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const deadLetterQueueName = `test-wager-dlq-${suffix}.fifo`;
  const queueName = `test-wager-${suffix}.fifo`;

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: deadLetterQueueName, Attributes: { FifoQueue: "true" } }));
  const dlqAttributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: "1",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  if (queue.QueueUrl === undefined || dlq.QueueUrl === undefined) {
    throw new Error("could not create test queues");
  }
  return { queueName, deadLetterQueueName, queueUrl: queue.QueueUrl, deadLetterQueueUrl: dlq.QueueUrl };
}

export async function createTestStandardQueue(sqs: SQSClient, prefix: string): Promise<{ name: string; url: string }> {
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  if (QueueUrl === undefined) {
    throw new Error(`could not create queue ${name}`);
  }
  return { name, url: QueueUrl };
}

export async function purgeQueue(sqs: SQSClient, queueUrl: string): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}

export async function sendFifo(sqs: SQSClient, queueUrl: string, body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

export async function receiveOne(sqs: SQSClient, queueUrl: string, timeoutMs = 10_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        MessageAttributeNames: ["All"],
      }),
    );
    const [message] = Messages;
    if (message !== undefined) {
      return message;
    }
  }
  throw new Error(`no message arrived on ${queueUrl} within ${timeoutMs}ms`);
}

/** Receives (and deletes) messages until `expected` arrived or the timeout elapses. */
export async function drainQueue(sqs: SQSClient, queueUrl: string, expected: number, timeoutMs = 10_000): Promise<Message[]> {
  const received: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (received.length < expected && Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ["All"] }),
    );
    if (Messages.length > 0) {
      received.push(...Messages);
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: Messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
        }),
      );
    }
  }
  return received;
}
