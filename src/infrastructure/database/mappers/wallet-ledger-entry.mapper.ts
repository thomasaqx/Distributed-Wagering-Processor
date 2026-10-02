import { Money } from "../../../domain/money";
import { LedgerDirection, WalletLedgerEntry } from "../../../domain/wallet-ledger-entry";
import type { WalletLedgerEntryRecord } from "../schemas/wallet-ledger-entry.schema";

function toDirection(value: string): LedgerDirection {
  if (value === LedgerDirection.Debit || value === LedgerDirection.Credit) {
    return value;
  }
  throw new Error(`unknown ledger direction in database: ${value}`);
}

export const WalletLedgerEntryMapper = {
  toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: toDirection(record.direction),
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    };
  },
};
