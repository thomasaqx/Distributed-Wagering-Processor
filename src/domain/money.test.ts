import { describe, it, expect } from "bun:test";
import { Money, InvalidMoneyError, CurrencyMismatchError } from "./money";

describe("Money Domain Class", () => {
  
  describe("static from() validation rules", () => {
    it("accepts strictly formatted positive amounts with two decimal places", () => {
      const m1 = Money.from({ amount: "25.00", currency: "BRL" });
      const m2 = Money.from({ amount: "0.00", currency: "USD" });

      expect(m1.toString()).toBe("BRL 25.00");
      expect(m2.toString()).toBe("USD 0.00");
    });

    it("rejects malformed, empty, or wrong precision amounts including negative inputs", () => {
      const invalidAmounts = ["", "abc", "NaN", "Infinity", "1e5", "10.123", "25", "25.5", "-10.50", "-5.00"];

      invalidAmounts.forEach((amount) => {
        expect(() => Money.from({ amount, currency: "BRL" }))
          .toThrow(InvalidMoneyError);
      });
    });

    it("rejects invalid currency codes", () => {
      expect(() => Money.from({ amount: "10.00", currency: "brl" })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: "10.00", currency: "US" })).toThrow(InvalidMoneyError);
    });
  });

  describe("mathematical operations", () => {
    it("adds amounts of the same currency", () => {
      const m1 = Money.from({ amount: "10.50", currency: "BRL" });
      const m2 = Money.from({ amount: "14.50", currency: "BRL" });
      
      const result = m1.add(m2);
      
      expect(result.toString()).toBe("BRL 25.00");
    });

    it("handles decimal precision without floating point issues", () => {
      const m1 = Money.from({ amount: "0.10", currency: "BRL" });
      const m2 = Money.from({ amount: "0.20", currency: "BRL" });
      
      const result = m1.add(m2);
      
      expect(result.toString()).toBe("BRL 0.30");
    });

    it("throws on currency mismatch", () => {
      const m1 = Money.from({ amount: "10.00", currency: "BRL" });
      const m2 = Money.from({ amount: "10.00", currency: "USD" });

      expect(() => m1.add(m2)).toThrow(CurrencyMismatchError);
    });

        it("subtracts and negates", () => {
      const m = Money.from({ amount: "25.00", currency: "BRL" });
      const ten = Money.from({ amount: "10.00", currency: "BRL" });

      expect(m.subtract(ten).toString()).toBe("BRL 15.00");
      expect(ten.negate().isNegative()).toBe(true);
    });

    it("compares amounts", () => {
      const ten = Money.from({ amount: "10.00", currency: "BRL" });
      const twenty = Money.from({ amount: "20.00", currency: "BRL" });

      expect(ten.isLessThan(twenty)).toBe(true);
      expect(twenty.isLessThan(ten)).toBe(false);
      expect(ten.equals(Money.from({ amount: "10.00", currency: "BRL" }))).toBe(true);
    });

    it("treats zero as not positive", () => {
      expect(Money.zero("BRL").isZero()).toBe(true);
      expect(Money.zero("BRL").isPositive()).toBe(false);
      expect(Money.from({ amount: "10.00", currency: "BRL" }).isPositive()).toBe(true);
    });

    it("serializes to MoneyProps", () => {
      const m = Money.from({ amount: "25.00", currency: "BRL" });
      expect(m.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    });


    it("throws when comparing different currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
});

  });

});
