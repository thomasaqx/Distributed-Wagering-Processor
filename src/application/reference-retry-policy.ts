// Out-of-order references: retried with exponential backoff (2s, 4s, 8s, ... capped at 60s).
// With 10 attempts the provider has roughly 6 minutes to deliver the referenced transaction
// before the dependent one is REJECTED with REFERENCE_NOT_FOUND.
export const MAX_REFERENCE_ATTEMPTS = Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10);
const BASE_DELAY_MS = Number(process.env.PENDING_REFERENCE_BASE_DELAY_MS ?? 2_000);
const MAX_DELAY_MS = 60_000;

export function nextReferenceAttemptAt(attemptsSoFar: number, now: Date): Date {
  const delay = Math.min(BASE_DELAY_MS * 2 ** attemptsSoFar, MAX_DELAY_MS);
  return new Date(now.getTime() + delay);
}
