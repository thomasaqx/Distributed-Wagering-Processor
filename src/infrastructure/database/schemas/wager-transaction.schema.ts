import { EntitySchema } from "@mikro-orm/core";

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status: string;
  failureCode?: string | null;
  observedBalance?: string | null;
  // Scheduling of the PENDING_REFERENCE retry worker; infrastructure-only, not part of the domain model.
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", length: 64 },
    externalTransactionId: { type: "string", length: 128 },
    idempotencyKey: { type: "string", length: 255 },
    payloadHash: { type: "string", length: 64 },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string", length: 128 },
    gameId: { type: "string", length: 128 },
    kind: { type: "string", length: 16 },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: { type: "string", length: 128, nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string", length: 24 },
    failureCode: { type: "string", length: 64, nullable: true },
    observedBalance: { type: "decimal", precision: 20, scale: 2, nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceAttemptAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});
