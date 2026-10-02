import { Migration } from "@mikro-orm/migrations";

export class Migration20261002120000InitialSchema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) not null constraint wallets_balance_non_negative_ck check (balance >= 0),
        version integer not null constraint wallets_version_ck check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(64) not null,
        external_transaction_id varchar(128) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id varchar(128) not null,
        game_id varchar(128) not null,
        kind varchar(16) not null
          constraint wager_transactions_kind_ck
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id uuid references wager_transactions (id),
        status varchar(24) not null
          constraint wager_transactions_status_ck
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code varchar(64),
        observed_balance numeric(20, 2),
        reference_attempts integer not null default 0
          constraint wager_transactions_reference_attempts_ck check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        -- LOSS records an outcome without moving money, so it is the only kind allowed to carry 0.00.
        constraint wager_transactions_amount_ck
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_reversal_reference_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null))
      );
    `);

    // A referenced transaction can be reverted at most once per reversal kind.
    this.addSql(`
      create unique index wager_transactions_reversal_once_uq
        on wager_transactions (reference_transaction_id, kind)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);

    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        -- Monotonic insertion order: stable sort key for cursor pagination and ledger replay.
        sequence bigint generated always as identity,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction varchar(6) not null
          constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null constraint wallet_ledger_entries_amount_ck check (amount > 0),
        currency char(3) not null,
        balance_before numeric(20, 2) not null
          constraint wallet_ledger_entries_balance_before_ck check (balance_before >= 0),
        balance_after numeric(20, 2) not null
          constraint wallet_ledger_entries_balance_after_ck check (balance_after >= 0),
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_uq unique (transaction_id),
        constraint wallet_ledger_entries_sequence_uq unique (sequence),
        constraint wallet_ledger_entries_arithmetic_ck check (
          (direction = 'DEBIT' and balance_after = balance_before - amount)
          or (direction = 'CREDIT' and balance_after = balance_before + amount)
        )
      );
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_sequence_idx
        on wallet_ledger_entries (wallet_id, sequence);
    `);

    this.addSql(`
      create function reject_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function reject_ledger_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(64) not null,
        message_id varchar(128) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(64) not null
          constraint outbox_messages_event_type_ck check (event_type in (
            'WagerTransactionProcessed',
            'WagerTransactionRejected',
            'WalletBalanceChanged',
            'WagerTransactionPendingReference'
          )),
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 constraint outbox_messages_attempts_ck check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at timestamptz
      );
    `);

    this.addSql(`
      create index outbox_messages_due_idx
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql("drop table if exists outbox_messages;");
    this.addSql("drop table if exists inbox_messages;");
    this.addSql("drop table if exists wallet_ledger_entries;");
    this.addSql("drop function if exists reject_ledger_mutation();");
    this.addSql("drop table if exists wager_transactions;");
    this.addSql("drop table if exists wallets;");
  }
}
