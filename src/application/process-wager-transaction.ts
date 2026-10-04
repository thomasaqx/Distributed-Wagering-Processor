import { LockWaitTimeoutException, UniqueConstraintViolationException } from "@mikro-orm/core";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { EventContext, IntegrationEvent } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wager-events";
import { InboxMessage } from "../domain/inbox-message";
import { Money, type MoneyProps } from "../domain/money";
import { settleWagerTransaction, type SettlementOutcome } from "../domain/wager-settlement";
import {
  type FailureCode,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import { LedgerRepository } from "../infrastructure/database/repositories/ledger.repository";
import { InboxRepository, OutboxRepository } from "../infrastructure/database/repositories/messaging.repository";
import { WagerTransactionRepository } from "../infrastructure/database/repositories/wager-transaction.repository";
import { WalletRepository } from "../infrastructure/database/repositories/wallet.repository";
import { isTransientInfrastructureError } from "../infrastructure/database/transient-errors";
import { logger } from "../infrastructure/observability/logger";
import { metrics } from "../infrastructure/observability/metrics";
import {
  IdempotencyConflictError,
  InvalidRequestError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "./errors";
import { wagerPayloadHash } from "./payload-hash";
import { nextReferenceAttemptAt } from "./reference-retry-policy";
import type { WagerRequest } from "./request-schemas";

export interface InboxContext {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerCommand {
  request: WagerRequest;
  idempotencyKey: string;
  correlationId: string;
  source: "http" | "sqs";
  inbox?: InboxContext;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransaction {
  constructor(private readonly orm: MikroORM) {}

  async execute(command: ProcessWagerCommand): Promise<WagerResult> {
    const startedAt = performance.now();
    const payloadHash = wagerPayloadHash(command.request);
    try {
      const result = await this.orm.em.fork().transactional((em) => this.processInTransaction(em, command, payloadHash));
      this.record(command, result);
      return result;
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // Another instance committed the same key / external id / inbox message between our
        // check and our insert. Our transaction was rolled back; answer from what was committed.
        metrics.lockConflicts.inc({ type: "unique_violation" });
        const result = await this.resolveAfterRace(command, payloadHash);
        this.record(command, result);
        return result;
      }
      if (error instanceof LockWaitTimeoutException) {
        metrics.lockConflicts.inc({ type: "lock_timeout" });
        throw new TransientInfrastructureError(`wallet ${command.request.walletId} is busy, retry later`);
      }
      if (isTransientInfrastructureError(error)) {
        throw new TransientInfrastructureError("database temporarily unavailable, retry later");
      }
      throw error;
    } finally {
      metrics.processingDuration.observe({ source: command.source }, (performance.now() - startedAt) / 1000);
    }
  }

  private async processInTransaction(em: EntityManager, command: ProcessWagerCommand, payloadHash: string): Promise<WagerResult> {
    const { request } = command;
    const wallets = new WalletRepository(em);
    const transactions = new WagerTransactionRepository(em);
    const now = new Date();

    // Bounded wait for the wallet lock: a stuck holder turns into a retryable 503, not a hang.
    await em.execute("set local lock_timeout = '5s'");

    if (command.inbox !== undefined) {
      const inbox = InboxMessage.receive({ ...command.inbox, payloadHash });
      const firstDelivery = await new InboxRepository(em).tryRecord(inbox, now);
      if (!firstDelivery) {
        metrics.inboxDuplicates.inc();
        return this.replay(em, command, payloadHash);
      }
    }

    const locked = await wallets.lockById(request.walletId);
    if (locked === undefined) {
      throw new WalletNotFoundError(request.walletId);
    }

    // Checked AFTER taking the wallet lock: concurrent duplicates of the same request are
    // serialized by the lock, so the second one always sees the first one's committed row.
    const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing !== undefined) {
      return this.replayOrConflict(existing, payloadHash, command, locked.wallet);
    }
    const sameExternalId = await transactions.findByProviderExternalId(request.providerId, request.externalTransactionId);
    if (sameExternalId !== undefined) {
      metrics.idempotencyConflicts.inc();
      throw new IdempotencyConflictError(command.idempotencyKey);
    }

    const tx = this.createTransaction(command, payloadHash);
    const reference =
      request.referenceExternalTransactionId === undefined
        ? undefined
        : await transactions.findByProviderExternalId(request.providerId, request.referenceExternalTransactionId);
    const referenceAlreadyReversed =
      reference !== undefined && tx.requiresReference() ? await transactions.isReversed(reference.id) : false;

    const outcome = settleWagerTransaction({ transaction: tx, wallet: locked.wallet, reference, referenceAlreadyReversed, now });

    transactions.insert(tx, outcome.status === WagerTransactionStatus.PendingReference ? nextReferenceAttemptAt(0, now) : undefined);
    // Explicit flush: the ledger row references the transaction row (foreign key).
    await em.flush();
    persistOutcome(em, outcome, locked.wallet, tx, eventContext(command, now));
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
      wallets.update(locked);
    }

    return resultOf(tx, locked.wallet, false);
  }

  private createTransaction(command: ProcessWagerCommand, payloadHash: string): WagerTransaction {
    const { request } = command;
    try {
      return WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: request.walletId,
        playerId: request.playerId,
        roundId: request.roundId,
        gameId: request.gameId,
        kind: toKind(request.kind),
        money: Money.from(request.money),
        referenceExternalTransactionId: request.referenceExternalTransactionId,
      });
    } catch (error) {
      if (error instanceof InvalidWagerTransactionError) {
        throw new InvalidRequestError(error.message);
      }
      throw error;
    }
  }

  private async replay(em: EntityManager, command: ProcessWagerCommand, payloadHash: string): Promise<WagerResult> {
    const existing = await new WagerTransactionRepository(em).findByIdempotencyKey(command.idempotencyKey);
    if (existing === undefined) {
      throw new Error(`inbox message ${command.inbox?.messageId} has no transaction for key ${command.idempotencyKey}`);
    }
    const wallet = await new WalletRepository(em).findById(existing.walletId);
    return this.replayOrConflict(existing, payloadHash, command, wallet);
  }

  private replayOrConflict(
    existing: WagerTransaction,
    payloadHash: string,
    command: ProcessWagerCommand,
    wallet: Wallet | undefined,
  ): WagerResult {
    if (!existing.matchesPayload(payloadHash)) {
      metrics.idempotencyConflicts.inc();
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    metrics.idempotentReplays.inc({ source: command.source });
    return resultOf(existing, wallet, true);
  }

  private async resolveAfterRace(command: ProcessWagerCommand, payloadHash: string): Promise<WagerResult> {
    const em = this.orm.em.fork();
    const transactions = new WagerTransactionRepository(em);
    const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing === undefined) {
      metrics.idempotencyConflicts.inc();
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    const wallet = await new WalletRepository(em).findById(existing.walletId);
    return this.replayOrConflict(existing, payloadHash, command, wallet);
  }

  private record(command: ProcessWagerCommand, result: WagerResult): void {
    if (!result.idempotentReplay) {
      metrics.transactions.inc({ kind: command.request.kind, status: result.status, source: command.source });
    }
    logger.info(
      {
        correlationId: command.correlationId,
        messageId: command.inbox?.messageId,
        transactionId: result.transactionId,
        walletId: command.request.walletId,
        providerId: command.request.providerId,
        kind: command.request.kind,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      },
      "wager transaction handled",
    );
  }
}

/** Writes the ledger entry and the integration events that describe a settlement outcome. */
export function persistOutcome(
  em: EntityManager,
  outcome: SettlementOutcome,
  wallet: Wallet,
  tx: WagerTransaction,
  ctx: EventContext,
): void {
  const events: IntegrationEvent<unknown>[] = [];
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(tx, ctx));
      if (outcome.ledgerEntry !== undefined) {
        new LedgerRepository(em).insert(outcome.ledgerEntry);
        events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx));
      }
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(tx, ctx));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(tx, ctx));
      break;
  }
  new OutboxRepository(em).enqueue(events);
}

export function eventContext(command: { correlationId: string; inbox?: InboxContext }, now: Date): EventContext {
  return { correlationId: command.correlationId, causationId: command.inbox?.messageId, occurredAt: now };
}

export function resultOf(tx: WagerTransaction, wallet: Wallet | undefined, idempotentReplay: boolean): WagerResult {
  // PENDING_REFERENCE has no observed balance yet: report the wallet's current balance instead.
  const balance = tx.observedBalance ?? wallet?.balance ?? Money.zero(tx.money.currency);
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    idempotentReplay,
  };
}

function toKind(kind: WagerRequest["kind"]): WagerTransactionKind {
  switch (kind) {
    case "BET":
      return WagerTransactionKind.Bet;
    case "WIN":
      return WagerTransactionKind.Win;
    case "LOSS":
      return WagerTransactionKind.Loss;
    case "REFUND":
      return WagerTransactionKind.Refund;
    case "ROLLBACK":
      return WagerTransactionKind.Rollback;
  }
}
