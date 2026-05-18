/**
 * Noise filter for the client-errors ingest endpoint.
 *
 * Browsers report uncaught errors from React's streaming/hydration
 * internals (e.g., "Cannot read properties of null (reading
 * 'parentNode')") when external DOM manipulation races with React's
 * fallback→content swap. These errors are not actionable from our side
 * — they originate inside React's runtime code, fire in batches when a
 * user navigates a Suspense-bearing page, and clutter `error_logs`
 * without corresponding user-visible breakage.
 *
 * We drop these reports at the ingest endpoint so the log surface
 * stays focused on errors we can act on. The filter is intentionally
 * narrow: it matches stack frames that name React's minified runtime
 * functions ($RS, $RC, etc.) — symbols that essentially never appear
 * in application code. Anything else (including the same error message
 * with a different stack) still gets logged.
 *
 * Background: 2026-05-18 prod showed 30+ identical reports in one
 * minute from /events?query=… during Suspense + MobileFilterDrawer
 * hydration. See feedback_react_streaming_hydration_noise memory.
 */

/**
 * Stack frame markers for React's streaming/hydration runtime. These
 * appear as `at $RS(...)` (or similar) in stack traces — minified
 * names that React's bundle exposes for its internal SSR streaming
 * lifecycle (clientRenderBoundary, completeBoundary, etc.).
 */
const REACT_RUNTIME_FRAME_RE = /\bat \$R[A-Z]\b/;

/**
 * Returns true if a client-error report should be dropped without
 * logging. Currently matches only React streaming-hydration noise.
 * Narrow by design — when in doubt, prefer false (log it).
 */
export function isKnownClientNoise(stack: string | undefined): boolean {
  if (!stack) return false;
  return REACT_RUNTIME_FRAME_RE.test(stack);
}
