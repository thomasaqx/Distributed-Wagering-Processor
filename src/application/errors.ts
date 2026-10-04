/**
 * Errors the application layer raises for situations that are NOT business rejections.
 * Business rejections (insufficient funds, reference mismatch, ...) are a normal result with
 * status REJECTED and a failure code, never an exception.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
  constructor(reference: string) {
    super(`transaction ${reference} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";
  constructor(idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

export class InvalidRequestError extends ApplicationError {
  readonly code = "INVALID_REQUEST";
}

/** Database or broker unavailable, lock wait timeout: the caller may retry the same request. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TEMPORARILY_UNAVAILABLE";
}
