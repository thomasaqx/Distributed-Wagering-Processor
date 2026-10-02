import { describe, expect, it } from "bun:test";
import { Money } from "./money";
import { InvalidLedgerEntryError, LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("WalletLedgerEntry", () => {
  it("creates a balanced debit", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      money: brl("80.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("20.00"),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it("rejects a debit whose arithmetic does not balance", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-1",
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: brl("80.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("30.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
