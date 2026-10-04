import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { initTestOrm, resetDatabase } from "./support/database";

const WALLET = "00000000-0000-0000-0000-000000000001";
const PLAYER = "00000000-0000-0000-0000-0000000000aa";
const BET = "00000000-0000-0000-0000-0000000000b1";

describe("database schema guarantees", () => {
  let orm: MikroORM;
  const sql = (statement: string) => orm.em.fork().execute(statement);
  const insertTransaction = (id: string, extra: { kind?: string; status?: string; key?: string; ref?: string; refId?: string } = {}) =>
    sql(`insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
            game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, created_at)
         values ('${id}', 'p', '${id}', '${extra.key ?? id}', '${"a".repeat(64)}', '${WALLET}', '${PLAYER}', 'r', 'g',
                 '${extra.kind ?? "BET"}', 80.00, 'BRL', ${extra.ref === undefined ? "null" : `'${extra.ref}'`},
                 ${extra.refId === undefined ? "null" : `'${extra.refId}'`}, '${extra.status ?? "PROCESSED"}', now())`);

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await sql(`insert into wallets values ('${WALLET}', '${PLAYER}', 'BRL', 100.00, 1, now(), now())`);
    await insertTransaction(BET);
  });

  it("allows only one wallet per player and currency", async () => {
    await expect(sql(`insert into wallets values (gen_random_uuid(), '${PLAYER}', 'BRL', 0, 1, now(), now())`)).rejects.toThrow(
      /wallets_player_currency_uq/,
    );
  });

  it("rejects negative balances and invalid versions", async () => {
    await expect(sql(`update wallets set balance = -0.01`)).rejects.toThrow(/wallets_balance_non_negative_ck/);
    await expect(sql(`update wallets set version = 0`)).rejects.toThrow(/wallets_version_ck/);
  });

  it("enforces unique idempotency keys and provider external ids", async () => {
    await expect(insertTransaction(crypto.randomUUID(), { key: BET })).rejects.toThrow(/wager_transactions_idempotency_key_uq/);
  });

  it("only accepts known kinds and statuses, and requires a reference for reversals", async () => {
    await expect(insertTransaction(crypto.randomUUID(), { kind: "JACKPOT" })).rejects.toThrow(/wager_transactions_kind_ck/);
    await expect(insertTransaction(crypto.randomUUID(), { status: "DONE" })).rejects.toThrow(/wager_transactions_status_ck/);
    await expect(insertTransaction(crypto.randomUUID(), { kind: "REFUND" })).rejects.toThrow(/wager_transactions_reversal_reference_ck/);
    await expect(insertTransaction(crypto.randomUUID(), { status: "REJECTED" })).rejects.toThrow(/wager_transactions_failure_code_ck/);
  });

  it("lets a reference be reverted only once per reversal kind", async () => {
    await insertTransaction(crypto.randomUUID(), { kind: "REFUND", ref: BET, refId: BET });
    await expect(insertTransaction(crypto.randomUUID(), { kind: "REFUND", ref: BET, refId: BET })).rejects.toThrow(
      /wager_transactions_reversal_once_uq/,
    );
  });

  it("checks ledger arithmetic and allows at most one entry per transaction", async () => {
    const entry = (balanceAfter: string) =>
      sql(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
           values (gen_random_uuid(), '${WALLET}', '${BET}', 'DEBIT', 80.00, 'BRL', 100.00, ${balanceAfter}, now())`);

    await expect(entry("30.00")).rejects.toThrow(/wallet_ledger_entries_arithmetic_ck/);
    await entry("20.00");
    await expect(entry("20.00")).rejects.toThrow(/wallet_ledger_entries_transaction_uq/);
  });

  it("makes the ledger append-only", async () => {
    await sql(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
               values (gen_random_uuid(), '${WALLET}', '${BET}', 'DEBIT', 80.00, 'BRL', 100.00, 20.00, now())`);

    await expect(sql("update wallet_ledger_entries set amount = 1.00")).rejects.toThrow(/append-only: UPDATE/);
    await expect(sql("delete from wallet_ledger_entries")).rejects.toThrow(/append-only: DELETE/);
  });

  it("deduplicates inbox messages per consumer", async () => {
    const insert = () => sql(`insert into inbox_messages values ('consumer', 'msg-1', '${"a".repeat(64)}', now(), now())`);
    await insert();
    await expect(insert()).rejects.toThrow(/inbox_messages_pk/);
  });

  it("can migrate down and up again", async () => {
    await resetDatabase(orm);
    const down = await orm.migrator.down();
    expect(down).toHaveLength(1);
    const tables = await orm.em.fork().execute<{ count: string }[]>(
      "select count(*)::text as count from information_schema.tables where table_name = 'wallets'",
    );
    expect(tables[0]?.count).toBe("0");

    const up = await orm.migrator.up();
    expect(up).toHaveLength(1);
  });
});
