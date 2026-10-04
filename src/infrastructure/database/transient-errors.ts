import { ConnectionException, LockWaitTimeoutException } from "@mikro-orm/core";

const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EAI_AGAIN"]);

const TRANSIENT_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300", "55P03"]);

function codeOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

export function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  const code = codeOf(error) ?? codeOf(error instanceof Error ? error.cause : undefined);
  if (code !== undefined && (TRANSIENT_NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code) || code.startsWith("08"))) {
    return true;
  }
  return error instanceof Error && /Connection terminated|connection timeout/i.test(error.message);
}
