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
  // OPE-577 — a SPEC-LEVEL NOTICE, not an error. The ResizeObserver spec
  // requires the browser to fire this when a resize handler dirties layout and
  // the loop has to run again; every major framework trips it and no user ever
  // sees anything. 14 occurrences in 30 days, never actionable. Safe as
  // always-noise (not third-party) because it is un-actionable on EVERY route,
  // including auth ones — there is no version of it that blocks a signup.
  "resizeobserver loop",
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
  // Minified third-party null-deref. Anchored on the `evaluating <expr>` tail
  // because the leading "TypeError: null is not an object" prefix also appears
  // in genuine app errors.
  //
  // OPE-613 — keyed on the PROPERTY, not on the minified local. The entry used
  // to read `evaluating 'b.parentnode'`; a bundler-assigned single letter is
  // not a stable identifier of anything, so any rule keyed on one is defeated
  // by the next rebuild — and after a rebuild reassigns that letter, the same
  // rule can suppress a genuine fault instead. `normalizeErrorClass` now emits
  // `evaluating *.parentnode`, which survives renaming.
  //
  // Evidence for this one specifically: minified third-party DOM code, a
  // 3-second iPhone Safari loop-burst, 0 recurrence in 12 days. Ruled noise
  // 2026-07-17 (Render-Fault-CPI-Retro-2026-07-17.md, post-retro approvals §3).
  "evaluating *.parentnode",
  // OPE-613 — `evaluating 'o.id'` REMOVED, deliberately.
  //
  // OPE-251 seeded it as a third-party shape by assertion, with no supporting
  // evidence recorded, and it has never been adjudicated. It is also live: 34
  // occurrences across 20 distinct pathnames (/events/*, /blog/*, /venues/*,
  // /vendors/*, /for-vendors, /login), still firing on 2026-08-28.
  //
  // Suppressing it was already wrong; converting it to a build-stable
  // `*.id` would have made it WORSE, by closing the gap that let `s.id` reach
  // `proposed` and surface at all. So the family is now allowed to propose and
  // be ruled on its own evidence — which is the whole point of this ticket.
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

/**
 * OPE-577 — an extension-injected fault, detected by STACK SHAPE.
 *
 * ⚠️ This is deliberately NARROWER than the rule OPE-577 proposed, and the
 * ticket's own version would have suppressed our own render path.
 *
 * The ticket asked to denylist "`global code@<page-url>:1:N` with a
 * `window.<vendor>` property". Measured against 30 days of live `error_logs`,
 * `global code@` appears on 90 rows — and roughly 60 of them are the
 * `b.parentNode` family whose FIRST frame is
 * `$RS@https://meetmeatthefair.com/events/...:23:306805`. That is our own
 * bundle: `$RS` is React's streaming-resume frame, and the streaming payload
 * executes at page global scope, so `global code@` shows up as its SECOND
 * frame. Keying on the substring would suppress our own streaming render path —
 * exactly the over-suppression the ticket's own notes warn against.
 *
 * So both conditions are required, and both come from the six real extension
 * rows in that window (`_G`, `__firefox__`):
 *
 *   1. the FIRST stack frame is `global code@<url>:1:<col>` — line 1, i.e. a
 *      script executing at page top level rather than inside a module. Our
 *      bundles report line 23.
 *   2. the message is `ReferenceError: Can't find variable: <ident>` — an
 *      extension probing for its own global that a content-script race removed.
 *
 * A page of ours that genuinely threw a ReferenceError from an inline line-1
 * script would match, which is why this stays on the THIRD-PARTY list and keeps
 * the auth-route carve-out rather than going to the always list.
 */
export function isExtensionInjectionStack(
  message: string | null | undefined,
  stackTrace: string | null | undefined
): boolean {
  if (!message || !stackTrace) return false;
  if (!/can't find variable:/i.test(message)) return false;
  const firstFrame = stackTrace.split("\n")[0]?.trim() ?? "";
  return /^global code@\S+:1:\d+$/.test(firstFrame);
}

/**
 * OPE-577 — did the INGEST already say this came from a third party?
 *
 * `context.thirdParty` is written at report time by the client reporter, which
 * knows the script origin the browser attributed the fault to. That is
 * PROVENANCE rather than message text, so it is the most reliable signal
 * available and cannot be defeated by a string change.
 *
 * ⚠️ Impact is smaller than the ticket estimates. It calls this "a one-line
 * win" suppressing "the whole embed family"; measured over 30 days the flag is
 * present and true on **10 of 2,982** rows. Worth consulting — it is free and
 * exactly right when set — but it does not by itself quiet the queue.
 *
 * Parse failures are NOT third-party: a malformed context must never suppress.
 */
export function contextSaysThirdParty(context: string | null | undefined): boolean {
  if (!context) return false;
  try {
    const parsed: unknown = JSON.parse(context);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { thirdParty?: unknown }).thirdParty === true
    );
  } catch {
    return false;
  }
}

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
  /** OPE-577 — the ingest's own `context` JSON, for the `thirdParty` flag. */
  context?: string | null;
  /** OPE-577 — for extension-injection stack-shape detection. */
  stackTrace?: string | null;
}): NoiseVerdict {
  const { message, route, context, stackTrace } = input;
  if (!message) return { noise: false, reason: null, matched: null };
  const raw = message.toLowerCase();
  const normalized = normalizeErrorClass(message);
  const hits = (entry: string) => raw.includes(entry) || normalized.includes(entry);

  const always = NOISE_DENYLIST.find(hits);
  if (always) return { noise: true, reason: "always", matched: always };

  // OPE-577 — PROVENANCE-based suppression, checked before the text denylist
  // because it is the stronger signal: it says where the code came from rather
  // than what it happened to say.
  //
  // Both still honour the OPE-173 auth carve-out. That is not caution for its
  // own sake — `/register#script error.` WAS the registration-blocking
  // Turnstile throw, and a third-party-looking shape on an auth route is
  // exactly the case where being wrong is most expensive.
  const provenance = contextSaysThirdParty(context)
    ? "context.thirdParty"
    : isExtensionInjectionStack(message, stackTrace)
      ? "extension-injection-stack"
      : null;
  if (provenance) {
    if (isNoiseExemptRoute(route)) return { noise: false, reason: null, matched: provenance };
    return { noise: true, reason: "third-party", matched: provenance };
  }

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
      // OPE-613 — keep the property being dereferenced, BEFORE the quote strip
      // below removes it.
      //
      // `evaluating '<obj>.<prop>'` is the only token that identifies a client
      // TypeError, and stripping it collapsed three unrelated faults into one
      // class: `b.parentNode`, `o.id` and `s.id` all normalized to
      // `typeerror: null is not an object (evaluating )`. Two rows sat at
      // status='noise' under that class on a ruling made specifically about
      // `b.parentNode` — so an `.id` fault landing on those routes deduped into
      // a human's decision about a DIFFERENT fault and was never seen again.
      // A human cannot rule correctly on a key that erased the evidence.
      //
      // The object half is dropped when it looks MINIFIED (1–2 chars), because
      // it is a bundler-assigned local and rotates on every rebuild — observed
      // directly: the same family ran as `o.id` (29 hits, 17 routes, to 08-19)
      // and then as `s.id` (5 hits, 3 routes, from 08-28) across one deploy.
      // Keying on it under-matches after a rebuild and, worse, can silently
      // OVER-match a genuine fault that happens to minify to the same letter.
      //
      // A longer object name is a real identifier and is kept, because
      // `myWidget.id` and `cart.id` are genuinely different faults.
      // OPE-577 — the same idea, widened to the EXPRESSION forms OPE-613 missed.
      //
      // OPE-613's pattern required the dotted pair to be the ENTIRE quoted
      // payload, so it handled `evaluating 'b.parentNode'` and nothing else.
      // Safari also emits whole expressions, and the live specimen that filed
      // OPE-577 is one:
      //
      //   evaluating 'window.ethereum.selectedAddress = undefined'
      //
      // That fell through to the quote-strip below and reached a human as
      // `typeerror: undefined is not an object (evaluating )` — which reads
      // exactly like a genuine empty-collection fault in our own render path.
      // The ticket is explicit that classifying off that key would have filed a
      // phantom bug.
      //
      // So: take the LEADING dotted identifier path out of the payload and drop
      // the rest of the expression (the ` = undefined` tail is the volatile
      // half). The minified-object rule is unchanged from OPE-613.
      .replace(
        /evaluating (['"`])([a-z_$][\w$]*(?:\.[\w$]+)+)[^'"`]*\1/g,
        (_m, _q, path: string) => {
          const [head, ...rest] = path.split(".");
          return `evaluating ${head.length <= 2 ? "*" : head}.${rest.join(".")}`;
        }
      )
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
