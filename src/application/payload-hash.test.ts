import { describe, expect, it } from "bun:test";
import { canonicalJson, wagerPayloadHash, type WagerBusinessFields } from "./payload-hash";

const fields = (): WagerBusinessFields => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
});

describe("payload hash", () => {
  it("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: "x" } })).toBe('{"a":{"c":"x","d":true},"b":1}');
  });

  it("is a 64-char hex SHA-256", () => {
    expect(wagerPayloadHash(fields())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", () => {
    const original = fields();
    const reordered: WagerBusinessFields = {
      money: { currency: "BRL", amount: "25.00" },
      kind: original.kind,
      gameId: original.gameId,
      roundId: original.roundId,
      walletId: original.walletId,
      playerId: original.playerId,
      externalTransactionId: original.externalTransactionId,
      providerId: original.providerId,
    };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(original));
  });

  it("changes when any business field changes", () => {
    const original = wagerPayloadHash(fields());
    expect(wagerPayloadHash({ ...fields(), money: { amount: "25.01", currency: "BRL" } })).not.toBe(original);
    expect(wagerPayloadHash({ ...fields(), roundId: "round-988" })).not.toBe(original);
    expect(wagerPayloadHash({ ...fields(), referenceExternalTransactionId: "transaction-100" })).not.toBe(original);
  });
});
