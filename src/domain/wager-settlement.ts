import { InsufficientFundsError, type Wallet } from "./wallet";
import type { WalletLedgerEntry } from "./wallet-ledger-entry";
import {
  FailureCode,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference?: WagerTransaction;
  referenceAlreadyReversed: boolean;
  now: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry?: WalletLedgerEntry }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

const REVERSIBLE_KINDS: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  // WIN and LOSS may optionally point at the BET of the same round.
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Opening]: [],
};

/*
  Applies section 7 business rules to one transaction against a locked wallet. Pure domain logic:
  it mutates the transaction (status) and the wallet (balance) and returns what happened; the
 caller persists everything in one SQL transaction.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, now } = input;

  const preconditionFailure = checkPreconditions(input);
  if (preconditionFailure === "pending") {
    if (tx.status !== WagerTransactionStatus.PendingReference) {
      tx.markPendingReference();
    }
    return { status: WagerTransactionStatus.PendingReference };
  }
  if (preconditionFailure !== undefined) {
    return reject(tx, wallet, preconditionFailure, now);
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(wallet.balance, now, input.reference?.id);
    return { status: WagerTransactionStatus.Processed };
  }

  try {
    const ledgerEntry = isDebit(tx, input.reference)
      ? wallet.debit(tx.money, tx.id)
      : wallet.credit(tx.money, tx.id);
    tx.markProcessed(wallet.balance, now, input.reference?.id);
    return { status: WagerTransactionStatus.Processed, ledgerEntry };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      // A reversal that would overdraw is operationally different from a bet without funds.
      const code = tx.kind === WagerTransactionKind.Rollback ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds;
      return reject(tx, wallet, code, now);
    }
    throw error;
  }
}

function checkPreconditions(input: SettlementInput): FailureCode | "pending" | undefined {
  const { transaction: tx, wallet, reference } = input;

  if (wallet.playerId !== tx.playerId) {
    return FailureCode.WalletPlayerMismatch;
  }
  if (wallet.currency !== tx.money.currency) {
    return FailureCode.CurrencyMismatch;
  }
  if (tx.referenceExternalTransactionId === undefined) {
    return undefined;
  }
  if (reference === undefined) {
    return "pending";
  }
  if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
    return "pending";
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (
    reference.walletId !== tx.walletId ||
    reference.playerId !== tx.playerId ||
    reference.money.currency !== tx.money.currency ||
    reference.roundId !== tx.roundId
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (!REVERSIBLE_KINDS[tx.kind].includes(reference.kind)) {
    return FailureCode.InvalidReferenceKind;
  }
  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) {
      return FailureCode.AmountMismatch;
    }
    if (input.referenceAlreadyReversed) {
      return FailureCode.AlreadyReversed;
    }
  }
  return undefined;
}

/** BET debits; WIN, REFUND and OPENING credit; ROLLBACK inverts the direction of what it reverts. */
function isDebit(tx: WagerTransaction, reference: WagerTransaction | undefined): boolean {
  switch (tx.kind) {
    case WagerTransactionKind.Bet:
      return true;
    case WagerTransactionKind.Rollback:
      return reference !== undefined && reference.kind !== WagerTransactionKind.Bet;
    default:
      return false;
  }
}

function reject(tx: WagerTransaction, wallet: Wallet, code: FailureCode, now: Date): SettlementOutcome {
  tx.reject(code, wallet.balance, now);
  return { status: WagerTransactionStatus.Rejected, failureCode: code };
}
