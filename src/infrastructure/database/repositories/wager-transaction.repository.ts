import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../../domain/wager-transaction";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import { type WagerTransactionRecord, WagerTransactionSchema } from "../schemas/wager-transaction.schema";

export interface ClaimedPendingTransaction {
  transaction: WagerTransaction;
  record: WagerTransactionRecord;
}

export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.toDomain(await this.em.findOne(WagerTransactionSchema, { id }));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.toDomain(await this.em.findOne(WagerTransactionSchema, { idempotencyKey }));
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.toDomain(await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }));
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  insert(tx: WagerTransaction, nextReferenceAttemptAt?: Date): void {
    this.em.create(WagerTransactionSchema, {
      ...WagerTransactionMapper.toRecord(tx),
      referenceAttempts: 0,
      nextReferenceAttemptAt: nextReferenceAttemptAt ?? null,
    });
  }

  async claimDuePendingReference(now: Date): Promise<ClaimedPendingTransaction | undefined> {
    const [record] = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: "asc" }, limit: 1, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return record === undefined ? undefined : { transaction: WagerTransactionMapper.toDomain(record), record };
  }

  updateClaimed(claimed: ClaimedPendingTransaction, scheduling: { attempts: number; nextAttemptAt: Date | null }): void {
    this.em.assign(claimed.record, {
      ...WagerTransactionMapper.toRecord(claimed.transaction),
      referenceAttempts: scheduling.attempts,
      nextReferenceAttemptAt: scheduling.nextAttemptAt,
    });
  }

  private toDomain(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    return record === null ? undefined : WagerTransactionMapper.toDomain(record);
  }
}
