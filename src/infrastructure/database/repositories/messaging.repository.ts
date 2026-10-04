import type { EntityManager } from "@mikro-orm/postgresql";
import type { IntegrationEvent } from "../../../domain/events/integration-event";
import type { InboxMessage } from "../../../domain/inbox-message";
import { OutboxMessage } from "../../../domain/outbox-message";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper";
import { OutboxMessageSchema } from "../schemas/messaging.schema";

export class OutboxRepository {
  constructor(private readonly em: EntityManager) { }

  enqueue(events: IntegrationEvent<unknown>[]): void {
    for (const event of events) {
      this.em.create(OutboxMessageSchema, OutboxMessageMapper.toRecord(OutboxMessage.enqueue(event)));
    }
  }
}

export class InboxRepository {
  constructor(private readonly em: EntityManager) { }
  async tryRecord(message: InboxMessage, processedAt: Date): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, processedAt],
    );
    return rows.length > 0;
  }
}
