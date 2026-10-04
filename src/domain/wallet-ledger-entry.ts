import { Money } from "./money";

export class InvalidLedgerEntryError extends Error { }

export enum LedgerDirection {
    Debit = "DEBIT",
    Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
    createdAt: Date;
}

export class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) { }

    static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
        if (!props.money.isPositive()) {
            throw new InvalidLedgerEntryError("amount must be positive");
        }

        if (props.balanceAfter.isNegative()){
            throw new InvalidLedgerEntryError("balance after cannot be negative")
        }

        const now: Date = new Date();
        const entry = new WalletLedgerEntry(props.id,
            props.walletId,
            props.transactionId,
            props.direction,
            props.money,
            props.balanceBefore,
            props.balanceAfter,
            now
        )

        if (!entry.isBalanced()) {
            throw new InvalidLedgerEntryError("ledger entry arithmetic does not balance");
        }
        return entry;

    }

    static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(state.id,
            state.walletId,
            state.transactionId,
            state.direction,
            state.money,
            state.balanceBefore,
            state.balanceAfter,
            state.createdAt
        )
    }

    isBalanced(): boolean {
        let expected: Money;

        if (this.direction === LedgerDirection.Debit) {
            expected = this.balanceBefore.subtract(this.money);
        } else {
            expected = this.balanceBefore.add(this.money);
        }
        return expected.equals(this.balanceAfter);


    }
}


