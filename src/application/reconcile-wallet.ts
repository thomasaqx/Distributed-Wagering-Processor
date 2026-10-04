import { IsolationLevel } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { Money, type MoneyProps } from "../domain/money";
import { LedgerRepository } from "../infrastructure/database/repositories/ledger.repository";
import { WalletRepository } from "../infrastructure/database/repositories/wallet.repository";
import { logger } from "../infrastructure/observability/logger";
import { metrics } from "../infrastructure/observability/metrics";
import { WalletNotFoundError } from "./errors";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger
 * (sum of credits - sum of debits). Divergences are reported, logged and counted, never "fixed":
 * silently overwriting either side would destroy the evidence needed to investigate.
 */
@Injectable()
export class ReconcileWallet {
  constructor(private readonly orm: MikroORM) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    return this.orm.em.fork().transactional(
      async (em) => {
        const wallet = await new WalletRepository(em).findById(walletId);
        if (wallet === undefined) {
          throw new WalletNotFoundError(walletId);
        }
        const totals = await new LedgerRepository(em).totals(walletId);
        const currency = wallet.currency;
        const calculated = Money.from({ amount: totals.credits, currency }).subtract(Money.from({ amount: totals.debits, currency }));
        const difference = wallet.balance.subtract(calculated);
        const consistent = difference.isZero();

        if (!consistent) {
          metrics.reconciliationDivergences.inc();
          logger.warn(
            { correlationId, walletId, checkedEntries: totals.entries, difference: difference.toJSON().amount },
            "wallet balance diverges from ledger",
          );
        }

        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent,
          checkedEntries: totals.entries,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }
}
