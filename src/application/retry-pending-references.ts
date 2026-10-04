import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { settleWagerTransaction, type SettlementOutcome } from "../domain/wager-settlement";
import { FailureCode, WagerTransactionStatus } from "../domain/wager-transaction";
import { WagerTransactionRepository } from "../infrastructure/database/repositories/wager-transaction.repository";
import { WalletRepository } from "../infrastructure/database/repositories/wallet.repository";
import { logger } from "../infrastructure/observability/logger";
import { metrics } from "../infrastructure/observability/metrics";
import { PollingLoop } from "../infrastructure/workers/polling-loop";
import { persistOutcome } from "./process-wager-transaction";
import { MAX_REFERENCE_ATTEMPTS, nextReferenceAttemptAt } from "./reference-retry-policy";

@Injectable()
export class RetryPendingReferences implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop = new PollingLoop(
    "pending-reference-worker",
    Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1_000),
    () => this.processNext(),
  );

  constructor(private readonly orm: MikroORM) {}

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED !== "false") {
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Returns 1 when a row was handled, 0 when nothing was due. */
  async processNext(): Promise<number> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute("set local lock_timeout = '5s'");
      const now = new Date();
      const transactions = new WagerTransactionRepository(em);
      const claimed = await transactions.claimDuePendingReference(now);
      if (claimed === undefined) {
        return 0;
      }

      const tx = claimed.transaction;
      const wallets = new WalletRepository(em);
      const locked = await wallets.lockById(tx.walletId);
      if (locked === undefined || tx.referenceExternalTransactionId === undefined) {
        throw new Error(`pending transaction ${tx.id} has no wallet or reference`);
      }

      const reference = await transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
      const referenceAlreadyReversed =
        reference !== undefined && tx.requiresReference() ? await transactions.isReversed(reference.id) : false;
      let outcome: SettlementOutcome = settleWagerTransaction({
        transaction: tx,
        wallet: locked.wallet,
        reference,
        referenceAlreadyReversed,
        now,
      });

      const attempts = claimed.record.referenceAttempts + 1;
      let nextAttemptAt: Date | null = null;
      if (outcome.status === WagerTransactionStatus.PendingReference) {
        if (attempts >= MAX_REFERENCE_ATTEMPTS) {
          tx.reject(FailureCode.ReferenceNotFound, locked.wallet.balance, now);
          outcome = { status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReferenceNotFound };
        } else {
          nextAttemptAt = nextReferenceAttemptAt(attempts, now);
        }
      }

      transactions.updateClaimed(claimed, { attempts, nextAttemptAt });
      if (outcome.status !== WagerTransactionStatus.PendingReference) {
        // The PendingReference event was already emitted when the transaction first arrived.
        const ctx = { correlationId: crypto.randomUUID(), causationId: tx.id, occurredAt: now };
        persistOutcome(em, outcome, locked.wallet, tx, ctx);
        if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
          wallets.update(locked);
        }
      }

      metrics.referenceRetries.inc({ outcome: outcome.status });
      logger.info(
        { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, attempts, status: outcome.status },
        "pending reference retried",
      );
      return 1;
    });
  }
}
