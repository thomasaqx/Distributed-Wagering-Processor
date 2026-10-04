import { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Module } from "@nestjs/common";

export const WAGER_TRANSACTIONS_QUEUE = process.env.SQS_WAGER_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo";
export const WAGER_TRANSACTIONS_DLQ = process.env.SQS_WAGER_TRANSACTIONS_DLQ ?? "wager-transactions-dlq.fifo";
export const WALLET_EVENTS_QUEUE = process.env.SQS_WALLET_EVENTS_QUEUE ?? "wallet-events";

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

@Global()
@Module({
  providers: [{ provide: SQSClient, useFactory: createSqsClient }],
  exports: [SQSClient],
})
export class SqsModule {}
