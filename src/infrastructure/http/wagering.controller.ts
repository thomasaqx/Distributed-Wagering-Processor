import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res, UseGuards } from "@nestjs/common";
import { InvalidRequestError } from "../../application/errors";
import { ProcessWagerTransaction, type WagerResult } from "../../application/process-wager-transaction";
import { idempotencyKeySchema, parseOrThrow, wagerRequestSchema } from "../../application/request-schemas";
import { type TransactionView, WalletQueries } from "../../application/wallet-queries";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
import { AuthGuard } from "./auth.guard";
import { CorrelationId } from "./correlation-id";

interface StatusResponse {
  status(code: number): unknown;
}

const HTTP_STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<WagerResult> {
    if (idempotencyKeyHeader === undefined) {
      throw new InvalidRequestError("Idempotency-Key header is required");
    }
    const idempotencyKey = parseOrThrow(idempotencyKeySchema, idempotencyKeyHeader);
    const request = parseOrThrow(wagerRequestSchema, body);
    const result = await this.processWager.execute({ request, idempotencyKey, correlationId, source: "http" });
    response.status(HTTP_STATUS_BY_RESULT[result.status]);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  byId(@Param("transactionId", ParseUUIDPipe) transactionId: string): Promise<TransactionView> {
    return this.queries.transaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.transactionByExternalId(providerId, externalTransactionId);
  }
}
