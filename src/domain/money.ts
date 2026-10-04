import Decimal from "decimal.js";

export class InvalidMoneyError extends Error {}
export class CurrencyMismatchError extends Error {}

export interface MoneyProps {
    amount: string;
    currency: string;
}

export class Money {
    private static readonly AMOUNT_PATTERN = /^\d+\.\d{2}$/;
    private static readonly CURRENCY_PATTERN = /^[A-Z]{3}$/;

    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) { }

    static from(props: MoneyProps): Money {
        if (!Money.AMOUNT_PATTERN.test(props.amount)) {
            throw new InvalidMoneyError(`invalid amount: ${props.amount}`);
        }
        if (!Money.CURRENCY_PATTERN.test(props.currency)) {
            throw new InvalidMoneyError(`invalid currency: ${props.currency}`);
        }
        return new Money(new Decimal(props.amount), props.currency);
    }

    toString(): string {
        return `${this.currency} ${this.value.toFixed(2)}`;
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.plus(other.value), this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.minus(other.value), this.currency);
    }

    negate(): Money {
        return new Money(this.value.negated(), this.currency);
    }

    isZero(): boolean {
        return this.value.isZero();
    }

    isNegative(): boolean {
        return this.value.isNegative();
    }

    isPositive(): boolean {
        if (this.isZero()) {
            return false;
        }
        return this.value.isPositive();
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lt(other.value);
    }

    equals(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.eq(other.value);
    }

    toJSON(): MoneyProps {
        return { amount: this.value.toFixed(2), currency: this.currency };
    }

    static zero(currency: string): Money {
        return Money.from({ amount: "0.00", currency });
    }




    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(`cannot operate ${this.currency} with ${other.currency}`);
        }
    }
}
