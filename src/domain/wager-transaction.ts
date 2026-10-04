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

export interface WagerTransactionState extends CreateWagerTransactionProps {
    createdAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
    observedBalance?: Money;
}

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
];

const REVERSAL_KINDS: readonly WagerTransactionKind[] = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

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
        private _referenceTransactionId?: string,
        private _failureCode?: FailureCode,
        private _processedAt?: Date,
        private _observedBalance?: Money,
    ) { }

    static create(props: CreateWagerTransactionProps): WagerTransaction {
        if (REVERSAL_KINDS.includes(props.kind) && props.referenceExternalTransactionId === undefined) {
            throw new InvalidWagerTransactionError(props.kind + " requires referenceExternalTransactionId");
        }

        if (!props.money.isPositive() && props.kind !== WagerTransactionKind.Loss) {
            throw new InvalidWagerTransactionError(props.kind + " amount must be positive");
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

    static rehydrate(state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(
            state.id,
            state.providerId,
            state.externalTransactionId,
            state.idempotencyKey,
            state.payloadHash,
            state.walletId,
            state.playerId,
            state.roundId,
            state.gameId,
            state.kind,
            state.money,
            state.referenceExternalTransactionId,
            state.createdAt,
            state.status,
            state.referenceTransactionId,
            state.failureCode,
            state.processedAt,
            state.observedBalance,
        );
    }

    markProcessed(observedBalance: Money, at: Date, referenceTransactionId?: string): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.Processed;
        this._observedBalance = observedBalance;
        this._processedAt = at;
        this._referenceTransactionId = referenceTransactionId;
    }

    markPendingReference(): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.PendingReference;
    }

    reject(code: FailureCode, observedBalance: Money, at: Date): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
        this._observedBalance = observedBalance;
        this._processedAt = at;
    }

    fail(code: FailureCode, at: Date): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
        this._processedAt = at;
    }

    // ---- domain queries

    isTerminal(): boolean {
        return TERMINAL_STATUSES.includes(this._status);
    }

    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    requiresReference(): boolean {
        return REVERSAL_KINDS.includes(this.kind);
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    private assertNotTerminal(): void {
        if (this.isTerminal()) {
            throw new InvalidTransactionStateError(`transaction ${this.id} is already ${this._status}`);
        }
    }

    get status(): WagerTransactionStatus { return this._status; }
    get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
    get failureCode(): FailureCode | undefined { return this._failureCode; }
    get processedAt(): Date | undefined { return this._processedAt; }
    get observedBalance(): Money | undefined { return this._observedBalance; }
}
