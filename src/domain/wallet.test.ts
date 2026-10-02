import { describe, expect, it } from "bun:test";
import { Money } from "./money";
import { InvalidWalletError, Wallet } from "./wallet";

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

});
