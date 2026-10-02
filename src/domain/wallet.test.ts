import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, Money } from "./money";
import { InsufficientFundsError, InvalidWalletError, Wallet } from "./wallet";
import { LedgerDirection } from "./wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const openWallet = (amount: string) =>
  Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(amount) });

describe("Wallet", () => {
  it("opens with version 1 and the initial balance", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    expect(wallet.balance.toString()).toBe("BRL 100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
  });

  it("rehydrates persisted state without changing it", () => {
    const createdAt = new Date("2026-03-01T10:00:00.000Z");
    const updatedAt = new Date("2026-09-30T18:00:00.000Z");

    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: Money.from({ amount: "55.00", currency: "BRL" }),
      version: 7,
      createdAt,
      updatedAt,
    });

    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

    it("throws InvalidWalletError when opening with a negative balance", () => {
    const negativeBalance = Money.from({ amount: "10.00", currency: "BRL" }).negate();

    expect(() => {
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: negativeBalance,
      });
    }).toThrow(InvalidWalletError);
  });

  it("debits the balance, bumps the version and returns a matching ledger entry", () => {
    const wallet = openWallet("100.00");

    const entry = wallet.debit(brl("80.00"), "tx-1");

    expect(wallet.balance.toString()).toBe("BRL 20.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.balanceBefore.toString()).toBe("BRL 100.00");
    expect(entry.balanceAfter.toString()).toBe("BRL 20.00");
  });

  it("rejects a debit beyond the balance and leaves the wallet untouched", () => {
    const wallet = openWallet("20.00");

    expect(() => wallet.debit(brl("80.00"), "tx-1")).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("BRL 20.00");
    expect(wallet.version).toBe(1);
  });

  it("allows debiting the whole balance down to zero", () => {
    const wallet = openWallet("80.00");

    wallet.debit(brl("80.00"), "tx-1");

    expect(wallet.balance.isZero()).toBe(true);
  });

  it("credits the balance and returns a credit ledger entry", () => {
    const wallet = openWallet("20.00");

    const entry = wallet.credit(brl("50.00"), "tx-1");

    expect(wallet.balance.toString()).toBe("BRL 70.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it("rejects operations in a different currency without changing the wallet", () => {
    const wallet = openWallet("100.00");
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => wallet.debit(usd, "tx-1")).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, "tx-2")).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it("rejects a zero-amount debit without changing the wallet", () => {
    const wallet = openWallet("100.00");

    expect(() => wallet.debit(brl("0.00"), "tx-1")).toThrow();
    expect(wallet.version).toBe(1);
  });
});
