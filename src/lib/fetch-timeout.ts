/**
 * Fetch wrapper with AbortController-based timeout.
 * Prevents external services from consuming the full Workers CPU time limit.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = 10000, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchInit, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps any promise with a timeout. Useful for APIs like Workers AI `ai.run()`
 * that don't accept AbortSignal.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);
}
