import { BigIntType, EntitySchema } from "@mikro-orm/core";

export interface WalletLedgerEntryRecord {
  id: string;
  // Assigned by the database (identity column); only present on loaded rows.
  sequence?: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    sequence: { type: new BigIntType("string"), generated: "by default as identity", nullable: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string", length: 6 },
    amount: { type: "decimal", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "decimal", precision: 20, scale: 2 },
    balanceAfter: { type: "decimal", precision: 20, scale: 2 },
    createdAt: { type: "datetime" },
  },
});
