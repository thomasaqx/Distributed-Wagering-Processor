import { z } from "zod";
import { InvalidRequestError } from "./errors";

const moneySchema = z.strictObject({
  amount: z.string().regex(/^\d{1,18}\.\d{2}$/, "amount must be a non-negative decimal string with 2 places"),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO-4217 code"),
});

const identifier = (maxLength: number) => z.string().trim().min(1).max(maxLength);

export const wagerRequestSchema = z.strictObject({
  providerId: identifier(64),
  externalTransactionId: identifier(128),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier(128),
  gameId: identifier(128),
  kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: moneySchema,
  referenceExternalTransactionId: identifier(128).optional(),
});

export type WagerRequest = z.infer<typeof wagerRequestSchema>;

export const idempotencyKeySchema = identifier(255);

export const wagerQueueMessageSchema = z.strictObject({
  messageId: identifier(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime(),
  data: wagerRequestSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerQueueMessage = z.infer<typeof wagerQueueMessageSchema>;

export const createWalletRequestSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

export type CreateWalletRequest = z.infer<typeof createWalletRequestSchema>;

export const ledgerQuerySchema = z.strictObject({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InvalidRequestError(details);
  }
  return result.data;
}
