/**
 * D1 Retry Utility
 *
 * Wraps D1 operations with automatic retry logic for transient errors.
 * D1 can experience temporary failures that resolve with a retry.
 */

// Errors that are safe to retry
const RETRYABLE_ERRORS = [
  "database is locked",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "network error",
  "connection reset",
  "ECONNRESET",
  "socket hang up",
  "timeout",
];

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return RETRYABLE_ERRORS.some((e) => message.includes(e.toLowerCase()));
}

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

/**
 * Execute a D1 operation with automatic retry on transient errors.
 *
 * @example
 * ```ts
 * const result = await withD1Retry(
 *   () => db.select().from(events).where(eq(events.id, id)),
 *   { maxRetries: 3 }
 * );
 * ```
 */
export async function withD1Retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        throw lastError;
      }

      // Don't retry if we've exhausted attempts
      if (attempt === maxRetries) {
        console.error(
          `D1 operation failed after ${maxRetries + 1} attempts:`,
          lastError.message
        );
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      console.warn(
        `D1 transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms:`,
        lastError.message
      );

      await sleep(delay);
    }
  }

  // TypeScript safety - should never reach here
  throw lastError ?? new Error("Unexpected retry failure");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a retry-wrapped version of a database operation function.
 *
 * @example
 * ```ts
 * const getEventById = createRetryableOperation(
 *   async (id: string) => {
 *     const db = getCloudflareDb();
 *     return db.query.events.findFirst({ where: eq(events.id, id) });
 *   }
 * );
 *
 * const event = await getEventById("123");
 * ```
 */
export function createRetryableOperation<TArgs extends unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withD1Retry(() => operation(...args), options);
}
