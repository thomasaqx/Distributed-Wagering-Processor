import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events/wager-events";
import { Money, type MoneyProps } from "../domain/money";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { LedgerRepository } from "../infrastructure/database/repositories/ledger.repository";
import { OutboxRepository } from "../infrastructure/database/repositories/messaging.repository";
import { WagerTransactionRepository } from "../infrastructure/database/repositories/wager-transaction.repository";
import { WalletRepository } from "../infrastructure/database/repositories/wallet.repository";
import { logger } from "../infrastructure/observability/logger";
import { WalletAlreadyExistsError } from "./errors";
import { canonicalJson, sha256Hex } from "./payload-hash";
import type { CreateWalletRequest } from "./request-schemas";

export const INTERNAL_PROVIDER_ID = "internal";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function walletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}


@Injectable()
export class CreateWallet {
  constructor(private readonly orm: MikroORM) {}

  async execute(request: CreateWalletRequest, correlationId: string): Promise<WalletView> {
    const initialBalance = Money.from(request.initialBalance);
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: request.playerId, initialBalance });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        new WalletRepository(em).insert(wallet);
        await em.flush();
        if (!initialBalance.isPositive()) {
          return;
        }

        const now = new Date();
        const opening = WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${wallet.id}`,
          payloadHash: sha256Hex(canonicalJson({ walletId: wallet.id, playerId: wallet.playerId, money: initialBalance.toJSON() })),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: "opening",
          gameId: "opening",
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
        });
        opening.markProcessed(wallet.balance, now);
        new WagerTransactionRepository(em).insert(opening);
        await em.flush();

        const entry = wallet.openingEntry(opening.id);
        new LedgerRepository(em).insert(entry);
        const ctx = { correlationId, occurredAt: now };
        new OutboxRepository(em).enqueue([WagerTransactionProcessed.from(opening, ctx), WalletBalanceChanged.from(wallet, entry, ctx)]);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(request.playerId, initialBalance.currency);
      }
      throw error;
    }

    logger.info({ correlationId, walletId: wallet.id }, "wallet created");
    return walletView(wallet);
  }
}
