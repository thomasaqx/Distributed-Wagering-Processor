import { CurrencyMismatchError, Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export class InvalidWalletError extends Error { }
export class InsufficientFundsError extends Error { }

export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
}

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) { }

    static open(props: OpenWalletProps): Wallet {
        if (props.initialBalance.isNegative()) {
            throw new InvalidWalletError("initial balance cannot be negative");
        }

        const now: Date = new Date();
        return new Wallet(props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            now,
            now
        )
    }

    static rehydrate(state: WalletState): Wallet {
        return new Wallet(state.id,
            state.playerId,
            state.currency,
            state.balance,
            state.version,
            state.createdAt,
            state.updatedAt
        )
    }

    debit(money: Money, transactionId: string): WalletLedgerEntry {
        this.assertSameCurrency(money);

        const before = this.balance;
        const after = before.subtract(money);

        if (after.isNegative()) {
            throw new InsufficientFundsError("insufficient funds");
        }

        const entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: this.id,
            transactionId: transactionId,
            direction: LedgerDirection.Debit,
            money: money,
            balanceBefore: before,
            balanceAfter: after
        });

        this._balance = after;
        this._version += 1;
        this._updatedAt = entry.createdAt;

        return entry;
    }

    credit(money: Money, transactionId: string): WalletLedgerEntry {
        this.assertSameCurrency(money);

        const before = this.balance;
        const after = before.add(money);

        const entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: this.id,
            transactionId,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: before,
            balanceAfter: after,
        });

        this._balance = after;
        this._version += 1;
        this._updatedAt = entry.createdAt;

        return entry;
    }

    openingEntry(transactionId: string): WalletLedgerEntry {
        if (this._version !== 1) {
            throw new InvalidWalletError(`wallet ${this.id} is not freshly opened`);
        }
        return WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: this.id,
            transactionId,
            direction: LedgerDirection.Credit,
            money: this._balance,
            balanceBefore: Money.zero(this.currency),
            balanceAfter: this._balance,
        });
    }

    get balance(): Money { return this._balance; }
    get version(): number { return this._version; }
    get updatedAt(): Date { return this._updatedAt; }

    private assertSameCurrency(money: Money): void {
        if (money.currency !== this.currency) {
            throw new CurrencyMismatchError(`cannot operate ${this.currency} wallet with ${money.currency}`);
        }
    }
}
