import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../../src/infrastructure/database/mikro-orm.config";

export async function initTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  return orm;
}

export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute(
    "truncate table wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages restart identity cascade",
  );
}
