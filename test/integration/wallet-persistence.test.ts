import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { LockMode } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { WalletLedgerEntryMapper } from "../../src/infrastructure/database/mappers/wallet-ledger-entry.mapper";
import { WalletMapper } from "../../src/infrastructure/database/mappers/wallet.mapper";
import { WalletLedgerEntrySchema } from "../../src/infrastructure/database/schemas/wallet-ledger-entry.schema";
import { WalletSchema } from "../../src/infrastructure/database/schemas/wallet.schema";
import { initTestOrm, resetDatabase } from "./support/database";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

async function insertWagerTransactionRow(orm: MikroORM, wallet: Wallet, id: string): Promise<void> {
  await orm.em.getConnection().execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, status, created_at)
     values (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', 80.00, 'BRL', 'PROCESSED', now())`,
    [id, id, `provider-a:${id}`, "a".repeat(64), wallet.id, wallet.playerId],
  );
}

async function insertWallet(orm: MikroORM, wallet: Wallet): Promise<void> {
  const em = orm.em.fork();
  em.create(WalletSchema, WalletMapper.toRecord(wallet));
  await em.flush();
}

describe("wallet persistence", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  it("round-trips a wallet through the mapper without losing precision", async () => {
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: brl("1000.10") });

    await insertWallet(orm, wallet);

    const record = await orm.em.fork().findOneOrFail(WalletSchema, { id: wallet.id });
    const loaded = WalletMapper.toDomain(record);

    expect(loaded.balance.toJSON()).toEqual({ amount: "1000.10", currency: "BRL" });
    expect(loaded.version).toBe(1);
  });

  it("loads a wallet with a pessimistic write lock inside a transaction", async () => {
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: brl("100.00") });
    await insertWallet(orm, wallet);

    const balance = await orm.em.fork().transactional(async (em) => {
      const record = await em.findOneOrFail(WalletSchema, { id: wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      return WalletMapper.toDomain(record).balance.toJSON().amount;
    });

    expect(balance).toBe("100.00");
  });

  it("persists a ledger entry and reads back the database-assigned sequence", async () => {
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: brl("100.00") });
    await insertWallet(orm, wallet);
    const transactionId = crypto.randomUUID();
    await insertWagerTransactionRow(orm, wallet, transactionId);

    const entry = wallet.debit(brl("80.00"), transactionId);
    const em = orm.em.fork();
    em.create(WalletLedgerEntrySchema, WalletLedgerEntryMapper.toRecord(entry));
    await em.flush();

    const record = await orm.em.fork().findOneOrFail(WalletLedgerEntrySchema, { id: entry.id });
    const loaded = WalletLedgerEntryMapper.toDomain(record);

    expect(record.sequence).toBe("1");
    expect(loaded.isBalanced()).toBe(true);
    expect(loaded.balanceAfter.toJSON().amount).toBe("20.00");
  });

  it("rejects a negative balance at the database even when the domain is bypassed", async () => {
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: brl("10.00") });
    const record = { ...WalletMapper.toRecord(wallet), balance: "-1.00" };

    const em = orm.em.fork();
    em.create(WalletSchema, record);

    await expect(em.flush()).rejects.toThrow(/wallets_balance_non_negative_ck/);
  });
});
