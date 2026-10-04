import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { IdempotencyConflictError } from "../../src/application/errors";
import { ProcessWagerTransaction, type WagerResult } from "../../src/application/process-wager-transaction";
import { RetryPendingReferences } from "../../src/application/retry-pending-references";
import { FailureCode, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { initTestOrm, resetDatabase } from "./support/database";
import {
  countLedgerEntries,
  expectLedgerConsistent,
  httpCommand,
  openWallet,
  wagerRequest,
  waitFor,
  walletBalance,
} from "./support/fixtures";

describe("concurrency", () => {
  let orm: MikroORM;
  let processWager: ProcessWagerTransaction;

  beforeAll(async () => {
    orm = await initTestOrm();
    processWager = new ProcessWagerTransaction(orm);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  it("applies the same BET sent 50 times in parallel exactly once", async () => {
    const wallet = await openWallet(orm, "100.00");
    const command = httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "25.00", currency: "BRL" } }));

    const results = await Promise.all(Array.from({ length: 50 }, () => processWager.execute(command)));

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    // Every replay reports the balance observed by the original processing.
    expect(new Set(results.map((result) => result.balance.amount))).toEqual(new Set(["75.00"]));
    expect(await walletBalance(orm, wallet.walletId)).toBe("75.00");
    expect(await countLedgerEntries(orm, wallet.walletId, "DEBIT")).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("lets exactly one of two concurrent 80.00 BETs win a 100.00 balance", async () => {
    const wallet = await openWallet(orm, "100.00");
    const bet = (id: string) =>
      httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: id, money: { amount: "80.00", currency: "BRL" } }));

    const results = await Promise.all([processWager.execute(bet("bet-a")), processWager.execute(bet("bet-b"))]);

    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    expect(results.find((result) => result.status === WagerTransactionStatus.Rejected)?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletBalance(orm, wallet.walletId)).toBe("20.00");
    expect(await countLedgerEntries(orm, wallet.walletId, "DEBIT")).toBe(1);

    // Retrying both requests never debits again.
    const retries = await Promise.all([processWager.execute(bet("bet-a")), processWager.execute(bet("bet-b"))]);
    expect(retries.every((result) => result.idempotentReplay)).toBe(true);
    expect(await countLedgerEntries(orm, wallet.walletId, "DEBIT")).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("keeps balances exact when many BETs race on one hot wallet", async () => {
    const wallet = await openWallet(orm, "100.00");

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        processWager.execute(httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: `hot-${i}`, money: { amount: "7.00", currency: "BRL" } }))),
      ),
    );

    const processed = results.filter((result) => result.status === WagerTransactionStatus.Processed).length;
    expect(processed).toBe(14); // floor(100 / 7)
    expect(await walletBalance(orm, wallet.walletId)).toBe("2.00");
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("processes different wallets in parallel without interference", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(orm, "50.00")));

    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, (_, i) =>
          processWager.execute(httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: `${wallet.walletId}-${i}`, money: { amount: "10.00", currency: "BRL" } }))),
        ),
      ),
    );

    for (const wallet of wallets) {
      expect(await walletBalance(orm, wallet.walletId)).toBe("0.00");
      await expectLedgerConsistent(orm, wallet.walletId);
    }
  });

  it("rejects the same idempotency key with a different payload under concurrency", async () => {
    const wallet = await openWallet(orm, "100.00");
    const original = httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "10.00", currency: "BRL" } }));
    const tampered = { ...original, request: { ...original.request, money: { amount: "90.00", currency: "BRL" } } };

    const settled = await Promise.allSettled([processWager.execute(original), processWager.execute(tampered)]);

    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<WagerResult> => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyConflictError);
    expect(await countLedgerEntries(orm, wallet.walletId, "DEBIT")).toBe(1);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("parks a REFUND that arrives before its BET and settles it once the BET exists", async () => {
    const wallet = await openWallet(orm, "100.00");
    const worker = new RetryPendingReferences(orm);

    const refund = await processWager.execute(
      httpCommand(wagerRequest(wallet, { kind: "REFUND", externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1", money: { amount: "30.00", currency: "BRL" } })),
    );
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await walletBalance(orm, wallet.walletId)).toBe("100.00");

    await processWager.execute(httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "30.00", currency: "BRL" } })));
    expect(await walletBalance(orm, wallet.walletId)).toBe("70.00");

    // Make the retry due now instead of waiting for the backoff.
    await orm.em.fork().execute("update wager_transactions set next_reference_attempt_at = now() where status = 'PENDING_REFERENCE'");
    await waitFor(async () => (await worker.processNext()) === 0 && (await walletBalance(orm, wallet.walletId)) === "100.00");

    expect(await countLedgerEntries(orm, wallet.walletId, "CREDIT")).toBe(2); // OPENING + REFUND
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("rejects a pending reference with REFERENCE_NOT_FOUND after the last attempt", async () => {
    const wallet = await openWallet(orm, "100.00");
    const worker = new RetryPendingReferences(orm);
    const refund = await processWager.execute(
      httpCommand(wagerRequest(wallet, { kind: "REFUND", externalTransactionId: "refund-1", referenceExternalTransactionId: "never-arrives", money: { amount: "30.00", currency: "BRL" } })),
    );

    await waitFor(async () => {
      await orm.em.fork().execute("update wager_transactions set next_reference_attempt_at = now() where status = 'PENDING_REFERENCE'");
      await worker.processNext();
      const rows = await orm.em.fork().execute<{ status: string; failure_code: string | null }[]>(
        "select status, failure_code from wager_transactions where id = ?",
        [refund.transactionId],
      );
      return rows[0]?.status === "REJECTED" && rows[0]?.failure_code === "REFERENCE_NOT_FOUND";
    }, 20_000, 10);

    expect(await walletBalance(orm, wallet.walletId)).toBe("100.00");
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it("never reverts the same BET twice even when REFUNDs race", async () => {
    const wallet = await openWallet(orm, "100.00");
    await processWager.execute(httpCommand(wagerRequest(wallet, { kind: "BET", externalTransactionId: "bet-1", money: { amount: "30.00", currency: "BRL" } })));

    const refunds = await Promise.all(
      ["refund-a", "refund-b", "rollback-c"].map((id) =>
        processWager.execute(
          httpCommand(
            wagerRequest(wallet, {
              kind: id.startsWith("refund") ? "REFUND" : "ROLLBACK",
              externalTransactionId: id,
              referenceExternalTransactionId: "bet-1",
              money: { amount: "30.00", currency: "BRL" },
            }),
          ),
        ),
      ),
    );

    expect(refunds.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(refunds.filter((result) => result.failureCode === FailureCode.AlreadyReversed)).toHaveLength(2);
    expect(await walletBalance(orm, wallet.walletId)).toBe("100.00");
    await expectLedgerConsistent(orm, wallet.walletId);
  });
});
