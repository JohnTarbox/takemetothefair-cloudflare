/**
 * REL1' §1 (2026-06-04) — sentinel error thrown by page-level data
 * fetchers when the D1 query (or any other unrecoverable I/O) fails.
 *
 * Distinguishes "query threw" from "query returned zero rows." Before
 * this class, every fetcher in `src/app/<surface>/page.tsx` followed the
 * pattern:
 *
 *   try { ... return data }
 *   catch (e) { logError(...); return <empty default>; }
 *
 * That produced byte-identical output between a real-zero-results page
 * and a server-error page — the 2026-06-04 D1 100-col outage was caught
 * by a user 17 hours after onset because nothing in the user-facing UI
 * or in the SEO crawl reflected the outage state.
 *
 * Now fetchers throw `FetchError` from their catch blocks. Next.js's
 * App Router routes thrown errors in Server Components to the nearest
 * `error.tsx`, which renders a "service temporarily unavailable" UI
 * — visibly distinct from a zero-result empty state, and a strong
 * signal to crawlers (Google's soft-404 detector treats error-shaped
 * pages differently from sparse-content pages).
 *
 * For [slug] detail pages: callers still use `notFound()` when the
 * fetcher returns null (genuine 404 — slug doesn't exist) and only
 * throw `FetchError` when the query itself failed. The two outcomes
 * stay semantically distinct.
 */

export class FetchError extends Error {
  /** Logical source for logError / error.tsx triage. */
  readonly source: string;
  /** Original underlying error (D1 exception, network error, etc.). */
  readonly cause: unknown;

  constructor(source: string, cause: unknown, message?: string) {
    super(message ?? `Fetch failed (${source})`);
    this.name = "FetchError";
    this.source = source;
    this.cause = cause;
  }
}

/** Type guard for use in error.tsx / middleware. */
export function isFetchError(e: unknown): e is FetchError {
  return e instanceof FetchError || (e instanceof Error && e.name === "FetchError");
}
