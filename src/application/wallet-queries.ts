import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { MoneyProps } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import { LedgerRepository } from "../infrastructure/database/repositories/ledger.repository";
import { WagerTransactionRepository } from "../infrastructure/database/repositories/wager-transaction.repository";
import { WalletRepository } from "../infrastructure/database/repositories/wallet.repository";
import { walletView, type WalletView } from "./create-wallet";
import { InvalidRequestError, TransactionNotFoundError, WalletNotFoundError } from "./errors";

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export function encodeCursor(sequence: string): string {
  return Buffer.from(`seq:${sequence}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^seq:(\d{1,19})$/.exec(decoded);
  if (match?.[1] === undefined) {
    throw new InvalidRequestError("invalid cursor");
  }
  return match[1];
}

export function transactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balance: tx.observedBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  async wallet(walletId: string): Promise<WalletView> {
    const wallet = await new WalletRepository(this.orm.em.fork()).findById(walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return walletView(wallet);
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const em = this.orm.em.fork();
    if ((await new WalletRepository(em).findById(walletId)) === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    const page = await new LedgerRepository(em).page(walletId, cursor === undefined ? undefined : decodeCursor(cursor), limit);
    return {
      walletId,
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.lastSequence === undefined ? null : encodeCursor(page.lastSequence),
    };
  }

  async transaction(transactionId: string): Promise<TransactionView> {
    const tx = await new WagerTransactionRepository(this.orm.em.fork()).findById(transactionId);
    if (tx === undefined) {
      throw new TransactionNotFoundError(transactionId);
    }
    return transactionView(tx);
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await new WagerTransactionRepository(this.orm.em.fork()).findByProviderExternalId(providerId, externalTransactionId);
    if (tx === undefined) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return transactionView(tx);
  }
}
