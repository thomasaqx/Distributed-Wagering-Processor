import { Money } from "../../../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction";
import type { WagerTransactionRecord } from "../schemas/wager-transaction.schema";

function enumValue<T extends string>(values: readonly T[], value: string, field: string): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`unknown ${field} in database: ${value}`);
  }
  return match;
}

const KINDS = Object.values(WagerTransactionKind);
const STATUSES = Object.values(WagerTransactionStatus);
const FAILURE_CODES = Object.values(FailureCode);

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: enumValue(KINDS, record.kind, "kind"),
      money: money(record.amount),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: enumValue(STATUSES, record.status, "status"),
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: record.failureCode == null ? undefined : enumValue(FAILURE_CODES, record.failureCode, "failure code"),
      processedAt: record.processedAt ?? undefined,
      observedBalance: record.observedBalance == null ? undefined : money(record.observedBalance),
    });
  },

  /** Columns owned by the domain model; scheduling columns are managed by the repository. */
  toRecord(tx: WagerTransaction): Omit<WagerTransactionRecord, "referenceAttempts" | "nextReferenceAttemptAt"> {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      observedBalance: tx.observedBalance?.toJSON().amount ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };
  },
};
