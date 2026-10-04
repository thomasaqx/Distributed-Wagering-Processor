import { describe, expect, it } from "bun:test";
import { Money } from "./money";
import { settleWagerTransaction, type SettlementInput } from "./wager-settlement";
import { FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";
import { Wallet } from "./wallet";
import { LedgerDirection } from "./wallet-ledger-entry";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const openWallet = (amount: string) => Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(amount) });

let sequence = 0;
function transaction(kind: WagerTransactionKind, amount: string, referenceExternalTransactionId?: string): WagerTransaction {
  sequence += 1;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `provider-a:ext-${sequence}`,
    payloadHash: "a".repeat(64),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    referenceExternalTransactionId,
  });
}

/** A reference that was already applied to the wallet (e.g. a BET of 30.00). */
function processed(kind: WagerTransactionKind, amount: string): WagerTransaction {
  const tx = transaction(kind, amount);
  tx.markProcessed(brl("0.00"), NOW);
  return tx;
}

function settle(overrides: Partial<SettlementInput> & Pick<SettlementInput, "transaction" | "wallet">) {
  return settleWagerTransaction({ referenceAlreadyReversed: false, now: NOW, ...overrides });
}

describe("wager settlement", () => {
  describe("BET", () => {
    it("debits the wallet and produces a DEBIT entry", () => {
      const wallet = openWallet("100.00");
      const bet = transaction(WagerTransactionKind.Bet, "80.00");

      const outcome = settle({ transaction: bet, wallet });

      expect(outcome.status).toBe(WagerTransactionStatus.Processed);
      expect(outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe("20.00");
      expect(bet.observedBalance?.toJSON().amount).toBe("20.00");
    });

    it("is rejected with INSUFFICIENT_FUNDS and leaves the wallet untouched", () => {
      const wallet = openWallet("20.00");
      const bet = transaction(WagerTransactionKind.Bet, "80.00");

      const outcome = settle({ transaction: bet, wallet });

      expect(outcome).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds });
      expect(wallet.balance.toJSON().amount).toBe("20.00");
      expect(wallet.version).toBe(1);
    });

    it("is rejected on currency mismatch", () => {
      const wallet = openWallet("100.00");
      const bet = WagerTransaction.create({
        ...propsOf(transaction(WagerTransactionKind.Bet, "10.00")),
        money: Money.from({ amount: "10.00", currency: "USD" }),
      });

      expect(settle({ transaction: bet, wallet })).toEqual({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.CurrencyMismatch,
      });
    });

    it("is rejected when the player does not own the wallet", () => {
      const wallet = Wallet.open({ id: "wallet-1", playerId: "someone-else", initialBalance: brl("100.00") });
      const bet = transaction(WagerTransactionKind.Bet, "10.00");

      expect(settle({ transaction: bet, wallet })).toEqual({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.WalletPlayerMismatch,
      });
    });
  });

  describe("WIN and LOSS", () => {
    it("WIN credits the wallet", () => {
      const wallet = openWallet("20.00");

      settle({ transaction: transaction(WagerTransactionKind.Win, "50.00"), wallet });

      expect(wallet.balance.toJSON().amount).toBe("70.00");
    });

    it("LOSS is processed without touching the balance or the ledger", () => {
      const wallet = openWallet("20.00");

      const outcome = settle({ transaction: transaction(WagerTransactionKind.Loss, "0.00"), wallet });

      expect(outcome).toEqual({ status: WagerTransactionStatus.Processed });
      expect(wallet.version).toBe(1);
    });
  });

  describe("REFUND", () => {
    it("credits back a processed BET", () => {
      const wallet = openWallet("70.00");
      const bet = processed(WagerTransactionKind.Bet, "30.00");
      const refund = transaction(WagerTransactionKind.Refund, "30.00", bet.externalTransactionId);

      const outcome = settle({ transaction: refund, wallet, reference: bet });

      expect(outcome.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.toJSON().amount).toBe("100.00");
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    it("waits as PENDING_REFERENCE when the BET has not arrived yet", () => {
      const wallet = openWallet("70.00");
      const refund = transaction(WagerTransactionKind.Refund, "30.00", "ext-not-yet");

      const outcome = settle({ transaction: refund, wallet });

      expect(outcome).toEqual({ status: WagerTransactionStatus.PendingReference });
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(wallet.version).toBe(1);
    });

    it.each([
      ["references something other than a BET", () => processed(WagerTransactionKind.Win, "30.00"), "30.00", false, FailureCode.InvalidReferenceKind],
      ["has a different amount", () => processed(WagerTransactionKind.Bet, "30.00"), "29.99", false, FailureCode.AmountMismatch],
      ["was already reversed", () => processed(WagerTransactionKind.Bet, "30.00"), "30.00", true, FailureCode.AlreadyReversed],
    ] as const)("is rejected when it %s", (_, makeReference, amount, alreadyReversed, expected) => {
      const wallet = openWallet("70.00");
      const reference = makeReference();
      const refund = transaction(WagerTransactionKind.Refund, amount, reference.externalTransactionId);

      const outcome = settle({ transaction: refund, wallet, reference, referenceAlreadyReversed: alreadyReversed });

      expect(outcome).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: expected });
      expect(wallet.balance.toJSON().amount).toBe("70.00");
    });

    it("is rejected when the BET belongs to another round", () => {
      const wallet = openWallet("70.00");
      const bet = WagerTransaction.create({ ...propsOf(transaction(WagerTransactionKind.Bet, "30.00")), roundId: "round-2" });
      bet.markProcessed(brl("70.00"), NOW);
      const refund = transaction(WagerTransactionKind.Refund, "30.00", bet.externalTransactionId);

      expect(settle({ transaction: refund, wallet, reference: bet })).toEqual({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceMismatch,
      });
    });

    it("is rejected when the BET itself was rejected", () => {
      const wallet = openWallet("70.00");
      const bet = transaction(WagerTransactionKind.Bet, "30.00");
      bet.reject(FailureCode.InsufficientFunds, brl("70.00"), NOW);
      const refund = transaction(WagerTransactionKind.Refund, "30.00", bet.externalTransactionId);

      expect(settle({ transaction: refund, wallet, reference: bet })).toEqual({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceNotProcessed,
      });
    });
  });

  describe("ROLLBACK", () => {
    it("of a BET credits the amount back", () => {
      const wallet = openWallet("70.00");
      const bet = processed(WagerTransactionKind.Bet, "30.00");

      settle({ transaction: transaction(WagerTransactionKind.Rollback, "30.00", bet.externalTransactionId), wallet, reference: bet });

      expect(wallet.balance.toJSON().amount).toBe("100.00");
    });

    it("of a WIN debits the amount back", () => {
      const wallet = openWallet("150.00");
      const win = processed(WagerTransactionKind.Win, "50.00");

      const outcome = settle({ transaction: transaction(WagerTransactionKind.Rollback, "50.00", win.externalTransactionId), wallet, reference: win });

      expect(outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe("100.00");
    });

    it("that would overdraw uses a failure code distinct from a BET without funds", () => {
      const wallet = openWallet("10.00");
      const win = processed(WagerTransactionKind.Win, "50.00");

      const outcome = settle({ transaction: transaction(WagerTransactionKind.Rollback, "50.00", win.externalTransactionId), wallet, reference: win });

      expect(outcome).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReversalWouldOverdraw });
      expect(wallet.balance.toJSON().amount).toBe("10.00");
    });

    it("cannot target a LOSS", () => {
      const wallet = openWallet("10.00");
      const loss = processed(WagerTransactionKind.Loss, "0.00");

      expect(settle({ transaction: transaction(WagerTransactionKind.Rollback, "10.00", loss.externalTransactionId), wallet, reference: loss })).toEqual({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InvalidReferenceKind,
      });
    });
  });
});

function propsOf(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
  };
}
