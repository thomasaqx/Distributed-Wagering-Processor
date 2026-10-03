import { Money } from "./money";

export class InvalidWagerTransactionError extends Error { }
export class InvalidTransactionStateError extends Error { }

export enum WagerTransactionKind {
    Opening = "OPENING",
    Bet = "BET",
    Win = "WIN",
    Loss = "LOSS",
    Refund = "REFUND",
    Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
    Pending = "PENDING",
    PendingReference = "PENDING_REFERENCE",
    Processed = "PROCESSED",
    Rejected = "REJECTED",
    Failed = "FAILED",
}

export enum FailureCode {
    InsufficientFunds = "INSUFFICIENT_FUNDS",
    ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
    CurrencyMismatch = "CURRENCY_MISMATCH",
    WalletNotFound = "WALLET_NOT_FOUND",
    WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
    ReferenceNotFound = "REFERENCE_NOT_FOUND",
    ReferenceMismatch = "REFERENCE_MISMATCH",
    InvalidReferenceKind = "INVALID_REFERENCE_KIND",
    ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
    AlreadyReversed = "ALREADY_REVERSED",
    AmountMismatch = "AMOUNT_MISMATCH",
}

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
}

export class WagerTransaction {
    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly externalTransactionId: string,
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,
        public readonly referenceExternalTransactionId: string | undefined,
        public readonly createdAt: Date,
        private _status: WagerTransactionStatus,
    ) { }

    static create(props: CreateWagerTransactionProps): WagerTransaction {
        if (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) {
            if (props.referenceExternalTransactionId === undefined) {
                throw new InvalidWagerTransactionError(props.kind + " requires referenceExternalTransactionId");
            }
        }

        if (!props.money.isPositive() && props.kind !== WagerTransactionKind.Loss){
            throw new InvalidWagerTransactionError( props.kind + "amount must be positive");
        }

        return new WagerTransaction(
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
            props.kind,
            props.money,
            props.referenceExternalTransactionId,
            new Date(),
            WagerTransactionStatus.Pending
        );
    }

    get status(): WagerTransactionStatus { return this._status; }
}
