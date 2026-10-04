import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { CreateWallet, type WalletView } from "../../application/create-wallet";
import { ReconcileWallet, type ReconciliationReport } from "../../application/reconcile-wallet";
import { createWalletRequestSchema, ledgerQuerySchema, parseOrThrow } from "../../application/request-schemas";
import { type LedgerPageView, WalletQueries } from "../../application/wallet-queries";
import { AuthGuard } from "./auth.guard";
import { CorrelationId } from "./correlation-id";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: WalletQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<WalletView> {
    return this.createWallet.execute(parseOrThrow(createWalletRequestSchema, body), correlationId);
  }

  @Get(":walletId")
  get(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<WalletView> {
    return this.queries.wallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId", ParseUUIDPipe) walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query);
    return this.queries.ledger(walletId, cursor, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  reconcile(
    @Param("walletId", ParseUUIDPipe) walletId: string,
    @CorrelationId() correlationId: string,
  ): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(walletId, correlationId);
  }
}
