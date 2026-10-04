import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../../src/infrastructure/database/mikro-orm.config";

// Integration tests run against their own database so they never touch the data of an
// application started with `docker compose up` on the same PostgreSQL server.
export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? "wagering_test";

let databaseReady: Promise<void> | undefined;

async function ensureTestDatabase(): Promise<void> {
  const admin = await MikroORM.init({ ...createOrmConfig(), entities: [], discovery: { warnWhenNoEntities: false } });
  try {
    const rows = await admin.em.execute<{ exists: boolean }[]>(
      "select exists (select 1 from pg_database where datname = ?) as exists",
      [TEST_DB_NAME],
    );
    if (rows[0]?.exists !== true) {
      // Identifier comes from our own constant/env, never from user input.
      await admin.em.execute(`create database "${TEST_DB_NAME}"`);
    }
  } finally {
    await admin.close();
  }
}

export async function initTestOrm(): Promise<MikroORM> {
  databaseReady ??= ensureTestDatabase();
  await databaseReady;
  const orm = await MikroORM.init({ ...createOrmConfig(), dbName: TEST_DB_NAME });
  await orm.migrator.up();
  return orm;
}

// TRUNCATE is deliberately not blocked by the ledger immutability trigger (UPDATE/DELETE only),
// so tests can reset state between cases.
export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em.execute(
    "truncate table wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages restart identity cascade",
  );
}
