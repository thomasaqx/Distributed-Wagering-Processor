import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../../src/application/create-wallet";
import type { ProcessWagerCommand } from "../../../src/application/process-wager-transaction";
import { ReconcileWallet } from "../../../src/application/reconcile-wallet";
import type { WagerRequest } from "../../../src/application/request-schemas";

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export async function openWallet(orm: MikroORM, amount: string): Promise<TestWallet> {
  const playerId = crypto.randomUUID();
  const wallet = await new CreateWallet(orm).execute(
    { playerId, initialBalance: { amount, currency: "BRL" } },
    "test",
  );
  return { walletId: wallet.id, playerId };
}

export function wagerRequest(
  wallet: TestWallet,
  overrides: Partial<WagerRequest> & Pick<WagerRequest, "kind" | "externalTransactionId">,
): WagerRequest {
  return {
    providerId: "provider-a",
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    money: { amount: "10.00", currency: "BRL" },
    ...overrides,
  };
}

export function httpCommand(request: WagerRequest): ProcessWagerCommand {
  return {
    request,
    idempotencyKey: `${request.providerId}:${request.externalTransactionId}`,
    correlationId: crypto.randomUUID(),
    source: "http",
  };
}

export async function walletBalance(orm: MikroORM, walletId: string): Promise<string> {
  const rows = await orm.em.fork().execute<{ balance: string }[]>("select balance::text as balance from wallets where id = ?", [walletId]);
  return rows[0]?.balance ?? "missing";
}

export async function countLedgerEntries(orm: MikroORM, walletId: string, direction?: "DEBIT" | "CREDIT"): Promise<number> {
  const rows = await orm.em.fork().execute<{ count: string }[]>(
    direction === undefined
      ? "select count(*)::text as count from wallet_ledger_entries where wallet_id = ?"
      : "select count(*)::text as count from wallet_ledger_entries where wallet_id = ? and direction = ?",
    direction === undefined ? [walletId] : [walletId, direction],
  );
  return Number(rows[0]?.count ?? 0);
}

/** The invariant every test ends with: wallet.balance == balance rebuilt from the ledger. */
export async function expectLedgerConsistent(orm: MikroORM, walletId: string): Promise<void> {
  const report = await new ReconcileWallet(orm).execute(walletId, "test");
  expect(report.difference.amount).toBe("0.00");
  expect(report.consistent).toBe(true);
}

/** Polls `check` until it returns true; fails after `timeoutMs`. Avoids arbitrary sleeps. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
