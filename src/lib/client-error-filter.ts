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

/**
 * Any frame that names a source location — `(https://…)`, `at /foo.tsx:1:2`,
 * or WebKit's `fn@https://…` form. Our own bundle always produces these:
 * chunks are same-origin and OPE-105 set `crossOrigin="anonymous"` on the
 * Next-emitted scripts precisely so frames keep their URLs.
 */
const FRAME_WITH_SOURCE_RE = /(https?:\/\/|\/_next\/|\.tsx?:|\.jsx?:)/;

/** A stack line that carries a real frame (not the leading `Error: msg` line). */
const FRAME_LINE_RE = /(^|\n)\s*(at\s+\S|\S+@)/;

/**
 * OPE-301 — true when a stack has real frames but NOT ONE of them names a
 * source location. That combination means the throwing code was never loaded
 * from a URL we serve: browser-extension content scripts, in-app-browser
 * injections (iOS Google-app, Facebook), translate/reader overlays, and
 * `eval`'d snippets all produce anonymous frames, while our own chunks do not.
 *
 * This LABELS ONLY — the caller still logs the error. It exists so a silent
 * third-party crash is attributable instead of being triaged as a site defect.
 *
 * Motivating case: `/events/barnstable-county-fair/2026` reported
 * `RangeError: Maximum call stack size exceeded.` three times in one 3m39s
 * session, stack `@ @ @ @ Pk@ Nk@ Pk@ Nk@ …` — every frame anonymous, 100%
 * from the iOS Google-app (GSA) in-app browser, not reproducible in WebKit
 * under the same UA and route, and with no recursive walk in that page's
 * render tree. It was filed as OPE-301, a P0-shaped "add a cycle guard"
 * render-fault ticket, against code that never ran. Across the whole
 * `window-error` corpus this signature is rare and exclusively third-party:
 * 293 of 298 stacks carry URLs; of the 5 that don't, the other two are a
 * browser-extension messaging error and an injected `SyntaxError`.
 *
 * Deliberately conservative — a stack with NO frames at all returns false
 * (unknown, not third-party), matching this module's when-in-doubt-log rule.
 */
export function isThirdPartyInjectedError(stack: string | undefined): boolean {
  if (!stack) return false;
  if (!FRAME_LINE_RE.test(stack)) return false;
  return !FRAME_WITH_SOURCE_RE.test(stack);
}
