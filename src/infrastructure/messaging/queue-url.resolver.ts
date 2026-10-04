import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";

@Injectable()
export class QueueUrlResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly sqs: SQSClient) {}

  async resolve(queueName: string): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached !== undefined) {
      return cached;
    }
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (QueueUrl === undefined) {
      throw new Error(`queue ${queueName} has no URL`);
    }
    this.cache.set(queueName, QueueUrl);
    return QueueUrl;
  }
}
