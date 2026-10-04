import { EntitySchema } from "@mikro-orm/core";

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string", length: 64 },
    payload: { type: "json" },
    occurredAt: { type: "datetime" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime" },
    publishedAt: { type: "datetime", nullable: true },
  },
});

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", length: 64, primary: true },
    messageId: { type: "string", length: 128, primary: true },
    payloadHash: { type: "string", length: 64 },
    receivedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});
