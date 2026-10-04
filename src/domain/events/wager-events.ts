import type { MoneyProps } from "../money";
import type { Wallet } from "../wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet-ledger-entry";
import type { FailureCode, WagerTransaction, WagerTransactionKind } from "../wager-transaction";
import { type EventContext, IntegrationEvent, eventPropsFrom } from "./integration-event";

interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
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
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
  };
}

function requireObservedBalance(tx: WagerTransaction): MoneyProps {
  if (tx.observedBalance === undefined) {
    throw new Error(`transaction ${tx.id} has no observed balance`);
  }
  return tx.observedBalance.toJSON();
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  balance: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      eventPropsFrom(tx.id, ctx, {
        ...transactionData(tx),
        balance: requireObservedBalance(tx),
        ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.failureCode === undefined) {
      throw new Error(`transaction ${tx.id} has no failure code`);
    }
    return new WagerTransactionRejected(
      eventPropsFrom(tx.id, ctx, {
        ...transactionData(tx),
        failureCode: tx.failureCode,
        balance: requireObservedBalance(tx),
      }),
    );
  }
}

export type WagerTransactionPendingReferenceData = WagerTransactionEventData;

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(eventPropsFrom(tx.id, ctx, transactionData(tx)));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      eventPropsFrom(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
