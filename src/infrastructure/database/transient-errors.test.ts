import { describe, expect, it } from "bun:test";
import { isTransientInfrastructureError } from "./transient-errors";

const withCode = (code: string) => Object.assign(new Error("driver error"), { code });

describe("transient infrastructure errors", () => {
  it("treats lost connections and lock timeouts as transient", () => {
    expect(isTransientInfrastructureError(withCode("ECONNREFUSED"))).toBe(true);
    expect(isTransientInfrastructureError(withCode("08006"))).toBe(true);
    expect(isTransientInfrastructureError(withCode("55P03"))).toBe(true);
    expect(isTransientInfrastructureError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("does not retry constraint violations or programming errors", () => {
    expect(isTransientInfrastructureError(withCode("23505"))).toBe(false);
    expect(isTransientInfrastructureError(withCode("23514"))).toBe(false);
    expect(isTransientInfrastructureError(new TypeError("x is undefined"))).toBe(false);
  });
});
