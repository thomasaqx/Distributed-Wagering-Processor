import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import { isTransientInfrastructureError } from "../database/transient-errors";
import { logger } from "../observability/logger";

const STATUS_BY_ERROR = new Map<abstract new (...args: never[]) => ApplicationError, HttpStatus>([
  [InvalidRequestError, HttpStatus.BAD_REQUEST],
  [WalletNotFoundError, HttpStatus.NOT_FOUND],
  [TransactionNotFoundError, HttpStatus.NOT_FOUND],
  [WalletAlreadyExistsError, HttpStatus.CONFLICT],
  [IdempotencyConflictError, HttpStatus.CONFLICT],
  [TransientInfrastructureError, HttpStatus.SERVICE_UNAVAILABLE],
]);

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

interface ErrorBody {
  error: { code: string; message: string };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const [status, body] = this.toResponse(exception);
    if (status >= 500) {
      logger.error({ err: exception, status }, "request failed");
    }
    response.status(status).json(body);
  }

  private toResponse(exception: unknown): [number, ErrorBody] {
    if (exception instanceof ApplicationError) {
      const status = this.statusFor(exception);
      return [status, { error: { code: exception.code, message: exception.message } }];
    }
    if (isTransientInfrastructureError(exception)) {
      return [HttpStatus.SERVICE_UNAVAILABLE, { error: { code: "TEMPORARILY_UNAVAILABLE", message: "retry later" } }];
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === HttpStatus.PAYLOAD_TOO_LARGE ? "PAYLOAD_TOO_LARGE" : HttpStatus[status] ?? "HTTP_ERROR";
      return [status, { error: { code, message: exception.message } }];
    }
    const clientStatus = bodyParserStatus(exception);
    if (clientStatus !== undefined) {
      const code = clientStatus === HttpStatus.PAYLOAD_TOO_LARGE ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST";
      return [clientStatus, { error: { code, message: "malformed request body" } }];
    }
    return [HttpStatus.INTERNAL_SERVER_ERROR, { error: { code: "INTERNAL_ERROR", message: "internal error" } }];
  }

  private statusFor(error: ApplicationError): number {
    for (const [type, status] of STATUS_BY_ERROR) {
      if (error instanceof type) {
        return status;
      }
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

function bodyParserStatus(exception: unknown): number | undefined {
  if (exception instanceof Error && "status" in exception && typeof exception.status === "number") {
    return exception.status >= 400 && exception.status < 500 ? exception.status : undefined;
  }
  return undefined;
}
