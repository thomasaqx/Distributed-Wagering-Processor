import { describe, expect, it } from "bun:test";
import { Money } from "./money";
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "./wager-transaction";

const validProps = (): CreateWagerTransactionProps => ({
  id: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  idempotencyKey: "provider-a:ext-1",
  payloadHash: "a".repeat(64),
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "25.00", currency: "BRL" }),
});

describe("WagerTransaction", () => {
  it("is born PENDING", () => {
    const tx = WagerTransaction.create(validProps());
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  it("requires a reference for REFUND", () => {
    expect(() =>
      WagerTransaction.create({ ...validProps(), kind: WagerTransactionKind.Refund }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it("creates a REFUND with referenceExternalTransactionId without error", () => {
    const tx = WagerTransaction.create({
      ...validProps(),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-0",
    });
    expect(tx.kind).toBe(WagerTransactionKind.Refund);
    expect(tx.referenceExternalTransactionId).toBe("ext-0");
  });

  it("creates a LOSS with zero money without error", () => {
    const tx = WagerTransaction.create({
      ...validProps(),
      kind: WagerTransactionKind.Loss,
      money: Money.zero("BRL"),
    });
    expect(tx.kind).toBe(WagerTransactionKind.Loss);
    expect(tx.money).toEqual(Money.zero("BRL"));
  });

  it("throws InvalidWagerTransactionError when creating a BET with zero money", () => {
    expect(() =>
      WagerTransaction.create({
        ...validProps(),
        kind: WagerTransactionKind.Bet,
        money: Money.zero("BRL"),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});
