import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { Wallet } from "../../../domain/wallet";
import { WalletMapper } from "../mappers/wallet.mapper";
import { type WalletRecord, WalletSchema } from "../schemas/wallet.schema";

export interface LockedWallet {
  wallet: Wallet;
  record: WalletRecord;
}

export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(walletId: string): Promise<LockedWallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record === null ? undefined : { wallet: WalletMapper.toDomain(record), record };
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id: walletId });
    return record === null ? undefined : WalletMapper.toDomain(record);
  }

  insert(wallet: Wallet): void {
    this.em.create(WalletSchema, WalletMapper.toRecord(wallet));
  }

  /** Copies the new balance/version onto the locked row; written on the next flush. */
  update(locked: LockedWallet): void {
    this.em.assign(locked.record, WalletMapper.toRecord(locked.wallet));
  }
}
