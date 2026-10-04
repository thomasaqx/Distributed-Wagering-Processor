import { describe, expect, it } from "bun:test";
import { Money } from "./money";
import {
  FailureCode,
  InvalidTransactionStateError,
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

  describe("transitions", () => {
    const balance = Money.from({ amount: "75.00", currency: "BRL" });
    const at = new Date("2026-10-03T12:00:00.000Z");

    it("marks a transaction processed with the observed balance", () => {
      const tx = WagerTransaction.create(validProps());
      tx.markProcessed(balance, at);

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.observedBalance?.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
      expect(tx.processedAt).toEqual(at);
      expect(tx.isTerminal()).toBe(true);
    });

    it("rejects with a failure code", () => {
      const tx = WagerTransaction.create(validProps());
      tx.reject(FailureCode.InsufficientFunds, balance, at);

      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it("moves from PENDING_REFERENCE to PROCESSED", () => {
      const tx = WagerTransaction.create({ ...validProps(), kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-0" });
      tx.markPendingReference();
      expect(tx.isTerminal()).toBe(false);

      tx.markProcessed(balance, at, "tx-0");
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId).toBe("tx-0");
    });

    it("never leaves a terminal state", () => {
      const tx = WagerTransaction.create(validProps());
      tx.markProcessed(balance, at);

      expect(() => tx.reject(FailureCode.InsufficientFunds, balance, at)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markProcessed(balance, at)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.InsufficientFunds, at)).toThrow(InvalidTransactionStateError);
    });

    it("rehydrates a terminal transaction without re-validating it", () => {
      const tx = WagerTransaction.rehydrate({
        ...validProps(),
        createdAt: at,
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        observedBalance: balance,
        processedAt: at,
      });

      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    });
  });

  describe("queries", () => {
    it("treats the same idempotency key with a different payload hash as a conflict, not a replay", () => {
      const tx = WagerTransaction.create(validProps());

      expect(tx.matchesPayload("a".repeat(64))).toBe(true);
      expect(tx.matchesPayload("b".repeat(64))).toBe(false);
    });

    it("knows which kinds move money and which need a reference", () => {
      const loss = WagerTransaction.create({ ...validProps(), kind: WagerTransactionKind.Loss });
      const rollback = WagerTransaction.create({ ...validProps(), kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-0" });

      expect(loss.affectsBalance()).toBe(false);
      expect(WagerTransaction.create(validProps()).affectsBalance()).toBe(true);
      expect(rollback.requiresReference()).toBe(true);
      expect(WagerTransaction.create(validProps()).requiresReference()).toBe(false);
    });
  });
});
