import type { EntityManager } from "@mikro-orm/postgresql";
import type { WalletLedgerEntry } from "../../../domain/wallet-ledger-entry";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";
import { WalletLedgerEntrySchema } from "../schemas/wallet-ledger-entry.schema";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  lastSequence?: string;
}

export interface LedgerTotals {
  credits: string;
  debits: string;
  entries: number;
}

export class LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  insert(entry: WalletLedgerEntry): void {
    this.em.create(WalletLedgerEntrySchema, WalletLedgerEntryMapper.toRecord(entry));
  }

  /** Keyset pagination on the immutable `sequence` column: stable under concurrent inserts. */
  async page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage> {
    const records = await this.em.find(
      WalletLedgerEntrySchema,
      afterSequence === undefined ? { walletId } : { walletId, sequence: { $gt: afterSequence } },
      { orderBy: { sequence: "asc" }, limit: limit + 1 },
    );
    const hasMore = records.length > limit;
    const pageRecords = hasMore ? records.slice(0, limit) : records;
    return {
      entries: pageRecords.map((record) => WalletLedgerEntryMapper.toDomain(record)),
      lastSequence: hasMore ? pageRecords.at(-1)?.sequence : undefined,
    };
  }

  /** Sums computed by PostgreSQL in NUMERIC, so reconciliation never goes through floating point. */
  async totals(walletId: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<
      { credits: string; debits: string; entries: string }[]
    >(
      `select
         coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(20, 2)::text as credits,
         coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(20, 2)::text as debits,
         count(*)::text as entries
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
    );
    return {
      credits: row?.credits ?? "0.00",
      debits: row?.debits ?? "0.00",
      entries: Number(row?.entries ?? 0),
    };
  }
}
