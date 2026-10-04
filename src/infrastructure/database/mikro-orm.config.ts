import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { Migration20261002120000InitialSchema } from "./migrations/Migration20261002120000InitialSchema";
import { InboxMessageSchema, OutboxMessageSchema } from "./schemas/messaging.schema";
import { WagerTransactionSchema } from "./schemas/wager-transaction.schema";
import { WalletLedgerEntrySchema } from "./schemas/wallet-ledger-entry.schema";
import { WalletSchema } from "./schemas/wallet.schema";

export function createOrmConfig() {
  return defineConfig({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "wagering",
    password: process.env.DB_PASSWORD ?? "wagering",
    dbName: process.env.DB_NAME ?? "wagering",
    entities: [WalletSchema, WalletLedgerEntrySchema, WagerTransactionSchema, OutboxMessageSchema, InboxMessageSchema],
    extensions: [Migrator],
    migrations: {
      tableName: "schema_migrations",
      migrationsList: [
        { name: "Migration20261002120000InitialSchema", class: Migration20261002120000InitialSchema },
      ],
      snapshot: false,
      snapshotOnMigrate: false,
      allOrNothing: true,
    },
  });
}
