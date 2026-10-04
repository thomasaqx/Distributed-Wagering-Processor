import type { LoggerService } from "@nestjs/common";
import pino from "pino";

// Structured JSON logs. Callers pass identifiers (correlationId, messageId, transactionId,
// walletId, providerId) as fields; full financial payloads are never logged.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "wagering-processor" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Routes NestJS framework logs through the same JSON logger. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    logger.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    logger.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    logger.trace({ context }, String(message));
  }
}
