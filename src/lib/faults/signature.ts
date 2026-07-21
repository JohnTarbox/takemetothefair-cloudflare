/**
 * OPE-81 — render-fault signature computation. PURE, no I/O, never throws.
 *
 * ── What a "signature" is ─────────────────────────────────────────────────────
 * Render faults land in `error_logs` (one row per occurrence) but nothing groups
 * them into work. A *signature* is the stable key that collapses every occurrence
 * of the SAME underlying fault into ONE unit — `route#error-class` — so the detect
 * →group→dedup→emit rail (see reconcile.ts) files ONE OPE per fault, not one per
 * occurrence. Stability across occurrences is the whole game: two rows that differ
 * only in a request id, a row/offset count, or a quoted literal MUST land on the
 * same signature, or a single fault fans out into a flood of near-duplicate work.
 *
 * ── Noise ─────────────────────────────────────────────────────────────────────
 * A big slice of `error_logs` is un-actionable browser/network noise (chunk-load
 * failures on deploy, offline fetch aborts, bot-malformed URLs). `isNoise` gates
 * those out BEFORE grouping so they never reach the ledger. John curates the
 * denylist in review — extend `NOISE_DENYLIST` as new noise classes surface.
 *
 * This module is deterministic and side-effect free.
 */

/**
 * Lowercase substrings that mark an occurrence as un-actionable noise — never
 * grouped, never emitted. Matched against both the raw and the normalized
 * message. Curated conservatively; John extends this in review as new
 * deploy/browser/bot noise classes surface.
 */
export const NOISE_DENYLIST: readonly string[] = [
  // Deploy-window chunk churn (client fetches a hash that just rotated).
  "loading chunk",
  "chunkloaderror",
  "failed to fetch dynamically imported module",
  // Offline / flaky-network fetch failures — the user's connection, not our code.
  "network error",
  "load failed",
  "networkerror when attempting to fetch resource",
  "the operation was aborted",
  // Client-side React hydration mismatches — a separate class of work, not a
  // server render fault; excluded from this rail.
  "hydration",
  // Bots hitting malformed / percent-mangled URLs — decode throws we can't fix.
  "malformed uri",
  "uri malformed",
  "decodeuricomponent",
  "invalid url",
];

/**
 * OPE-251 — third-party shapes that are noise on ORDINARY routes but must never
 * be suppressed on conversion/auth-critical ones.
 *
 * Why these are separate from NOISE_DENYLIST: entries there (chunk churn,
 * offline fetch) are un-actionable everywhere. These are un-actionable only
 * because they come from embeds we don't control — and the same *string* can be
 * a real, revenue-blocking fault elsewhere.
 *
 * That distinction is not theoretical. `/register#script error.` was NOT noise:
 * it was the CORS-masked form of the registration-blocking Turnstile throw
 * (OPE-173). A flat, route-independent denylist for `script error.` would have
 * suppressed the single most important client fault we have ever had.
 *
 * Why a denylist is needed at all: signatures are route-scoped, so a shape a
 * human closed as noise on one route re-proposes on every new route it appears
 * on — the ledger keeps re-litigating a decision already made.
 */
export const THIRD_PARTY_NOISE_DENYLIST: readonly string[] = [
  // Third-party chat/embed widget. Closed as noise 2026-07-05, re-proposed on
  // a /blog route 2026-07-06 — the case that filed OPE-251.
  "object not found matching id",
  // CORS-masked cross-origin throw. OPE-105's crossorigin=anonymous de-blinds
  // OUR bundle host; scripts served by third parties (challenges.cloudflare.com)
  // stay masked permanently, so this residue never goes to zero.
  "script error.",
  // Minified third-party null-derefs. Anchored on the `evaluating '<expr>'`
  // tail because the leading "TypeError: null is not an object" prefix also
  // appears in genuine app errors.
  "evaluating 'b.parentnode'",
  "evaluating 'o.id'",
];

/**
 * Route prefixes where NOTHING is auto-suppressed (OPE-173).
 *
 * Conversion and auth paths: a suppressed fault here costs a signup or a claim,
 * which is categorically worse than a triage slot spent on noise. When in
 * doubt, add the route — the cost of a false candidate is minutes; the cost of
 * a silenced one is a user who cannot register.
 */
export const NOISE_EXEMPT_ROUTE_PREFIXES: readonly string[] = [
  "/register",
  "/login",
  "/signin",
  "/signup",
  "/claim",
  "/verify",
  "/reset-password",
  "/vendor/apply",
  "/checkout",
];

/** True when `route` is conversion/auth-critical and must never be auto-suppressed. */
export function isNoiseExemptRoute(route: string | null | undefined): boolean {
  if (!route) return false; // unknown route → not exempt (see classifyNoise)
  const r = route.toLowerCase();
  return NOISE_EXEMPT_ROUTE_PREFIXES.some(
    (p) => r === p || r.startsWith(`${p}/`) || r.startsWith(`${p}?`)
  );
}

export type NoiseReason = "always" | "third-party";

export interface NoiseVerdict {
  noise: boolean;
  /** Which list matched — for the audit log and the suppressed-hits counter. */
  reason: NoiseReason | null;
  /** The denylist entry that matched, for the audit log. */
  matched: string | null;
}

/**
 * Route-aware noise classification (OPE-251).
 *
 * `NOISE_DENYLIST` suppresses everywhere. `THIRD_PARTY_NOISE_DENYLIST`
 * suppresses everywhere EXCEPT conversion/auth routes, where the same shape
 * stays a full candidate.
 */
export function classifyNoise(input: {
  message: string | null | undefined;
  route?: string | null;
}): NoiseVerdict {
  const { message, route } = input;
  if (!message) return { noise: false, reason: null, matched: null };
  const raw = message.toLowerCase();
  const normalized = normalizeErrorClass(message);
  const hits = (entry: string) => raw.includes(entry) || normalized.includes(entry);

  const always = NOISE_DENYLIST.find(hits);
  if (always) return { noise: true, reason: "always", matched: always };

  const thirdParty = THIRD_PARTY_NOISE_DENYLIST.find(hits);
  if (thirdParty) {
    // The OPE-173 carve-out.
    if (isNoiseExemptRoute(route)) return { noise: false, reason: null, matched: thirdParty };
    return { noise: true, reason: "third-party", matched: thirdParty };
  }

  return { noise: false, reason: null, matched: null };
}

/**
 * Normalize a message into a durable error CLASS: lowercase, whitespace-collapsed,
 * with volatile per-occurrence tokens stripped so the class is stable across
 * occurrences. Removes quoted string literals, uuids, long hex ids, standalone
 * numbers (request ids, offsets, row/column counts), and long punctuation runs.
 * Returns "" for empty/nullish input.
 *
 * Standalone numbers are stripped on WORD boundaries only, so embedded digits in
 * identifiers survive — e.g. `d1_error` keeps its `1`. Example:
 *   `D1_ERROR: too many SQL variables at offset 123`
 *     → `d1_error: too many sql variables at offset`
 */
export function normalizeErrorClass(message: string | null | undefined): string {
  if (!message) return "";
  return (
    message
      .toLowerCase()
      // Quoted string literals ('...', "...", `...`) — the quoted payload is
      // almost always a volatile value (a slug, a url, an id).
      .replace(/(['"`]).*?\1/g, "")
      // UUIDs.
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "")
      // Hex ids (0x-prefixed, or a bare run of 6+ hex chars).
      .replace(/\b0x[0-9a-f]+\b/g, "")
      .replace(/\b[0-9a-f]{6,}\b/g, "")
      // Standalone numbers (request ids, "at offset 123", "line 4 column 12",
      // decimals, thousands-separated). Word-boundary anchored so digits INSIDE
      // an identifier (d1_error) are preserved.
      .replace(/\b\d[\d.,]*\b/g, "")
      // Long punctuation runs (stack-frame arrows, separator gutter).
      .replace(/[^\w\s]{4,}/g, " ")
      // Collapse whitespace and trim.
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * True when the message is un-actionable noise — matched against both the raw
 * lowercased message and the normalized class so an entry hits regardless of
 * volatile-token stripping. Nullish input is not noise (it falls back to digest
 * downstream).
 */
export function isNoise(message: string | null | undefined, route?: string | null): boolean {
  return classifyNoise({ message, route }).noise;
}

/**
 * Compute the stable signature for a fault occurrence. The error class is
 * `normalizeErrorClass(message)`; when that's empty (a client-only row with no
 * real message) it falls back to the `digest` (OPE-80's cross-row join key). The
 * signature is `${route}#${errorClass || "digest:<digest>"}` with `route`
 * defaulting to `"unknown"`. Deterministic + stable across occurrences.
 */
export function computeSignature(input: {
  route: string | null | undefined;
  message: string | null | undefined;
  digest: string | null | undefined;
}): string {
  const errorClass = normalizeErrorClass(input.message);
  const routePart = input.route ?? "unknown";
  const classPart = errorClass || `digest:${input.digest ?? "none"}`;
  return `${routePart}#${classPart}`;
}

/**
 * The searchable OPE token for a signature — the analyst embeds this in the OPE
 * body so a later run's Linear dup pre-flight can find an already-filed fault.
 */
export function faultSigToken(signature: string): string {
  return `fault-sig:${signature}`;
}
