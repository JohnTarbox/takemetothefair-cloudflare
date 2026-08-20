/**
 * OPE-485 — one-shot recovery from a stale webpack chunk after a deploy.
 *
 * ## The failure
 *
 * A deploy replaces `_next/static/chunks/*`. A browser tab that loaded build A
 * still holds build A's manifest, so the next client-side navigation asks for a
 * chunk URL build B no longer serves. The lazy import rejects and the route
 * never renders — 60 occurrences across 49 distinct routes in 14 days, which is
 * the tell that this is not a per-page defect: no event page is broken, the
 * client's build pointer is.
 *
 * ## Why a reload is the right recovery, and a retry is not
 *
 * The asset is genuinely gone. Re-requesting it just re-throws, so a silent
 * retry converts one error into several and still shows the user nothing. A full
 * reload re-fetches the document, which hands back the CURRENT manifest, and the
 * navigation succeeds.
 *
 * ## Why the sentinel is not optional
 *
 * If the reload itself lands on a broken build — a half-propagated deploy, an
 * asset host having a bad minute — an unguarded handler reloads, fails, reloads,
 * forever, and the user cannot even read the error. The sentinel makes the
 * recovery strictly one-shot per incident.
 *
 * A COOLDOWN rather than a permanent flag, deliberately: a permanent
 * per-session flag would spend the tab's single recovery on the first deploy it
 * survives and leave it defenceless for every later one (sessions here outlive
 * several deploys). A time window gives every genuine incident one attempt while
 * still making a loop impossible, because a loop's attempts are milliseconds
 * apart and a real second incident is hours apart.
 *
 * The core is pure and injectable so the loop-prevention is actually tested,
 * rather than asserted in a comment.
 */

/** sessionStorage key holding the epoch-ms of the last recovery attempt. */
export const CHUNK_RELOAD_SENTINEL = "mmatf:stale-chunk-reload-at";

/**
 * Minimum gap between two recovery attempts in one tab.
 *
 * 60s is far longer than a reload round-trip (so a loop is blocked on its second
 * iteration) and far shorter than the gap between two deploys (so a genuinely
 * new incident still gets its one attempt).
 */
export const RELOAD_COOLDOWN_MS = 60_000;

/**
 * Messages that mean "the chunk this build asked for is not there".
 * Matched against the error message.
 */
const CHUNK_MESSAGE_RE =
  /chunkloaderror|loading chunk \S+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

/**
 * The webpack runtime frame. Required for the GENERIC message below, because
 * "Cannot read properties of undefined (reading 'call')" is an ordinary
 * application bug almost everywhere else — it only means a stale chunk when it
 * is thrown from the webpack module-factory call site, one frame earlier than
 * the ChunkLoadError we would otherwise see.
 */
const WEBPACK_RUNTIME_FRAME_RE = /webpack-[0-9a-f]+\.js/i;

/** The module-factory-undefined shape, in Chrome and Safari wording. */
const MODULE_FACTORY_RE =
  /cannot read propert(?:y|ies) of undefined \(reading '?call'?\)|undefined is not an object \(evaluating '\w+\.call'\)/i;

/**
 * True when this error is a stale-build chunk failure.
 *
 * Deliberately conservative: an unnecessary reload costs a user their scroll
 * position and any unsubmitted form state, so the generic module-factory shape
 * must ALSO carry a webpack runtime frame before it counts.
 */
export function isStaleChunkError(input: { message?: string; stack?: string }): boolean {
  const message = input.message ?? "";
  const stack = input.stack ?? "";
  if (CHUNK_MESSAGE_RE.test(message)) return true;
  return MODULE_FACTORY_RE.test(message) && WEBPACK_RUNTIME_FRAME_RE.test(stack);
}

/** Minimal storage surface, so tests do not need a DOM. */
export interface SentinelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Whether a recovery reload is allowed right now, recording the attempt when it
 * is. Returns false when one was already attempted inside the cooldown — which
 * is exactly the "the reload did not help" case, where the user must be left
 * with the error rather than an unbreakable refresh loop.
 *
 * A storage that throws (Safari private mode, disabled cookies) yields false:
 * without a working sentinel we cannot promise the loop is bounded, and an
 * unbounded reload loop is worse than the broken navigation it would fix.
 */
export function claimReloadAttempt(storage: SentinelStorage | null, nowMs: number): boolean {
  if (!storage) return false;
  try {
    const previous = storage.getItem(CHUNK_RELOAD_SENTINEL);
    if (previous !== null) {
      const last = Number.parseInt(previous, 10);
      if (Number.isFinite(last) && nowMs - last < RELOAD_COOLDOWN_MS) return false;
    }
    storage.setItem(CHUNK_RELOAD_SENTINEL, String(nowMs));
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover from a stale-chunk error by reloading exactly once. Returns true when
 * a reload was triggered.
 *
 * Callers report the error BEFORE calling this: `reportClientError` uses
 * `navigator.sendBeacon`, which survives the unload a reload causes, so the
 * occurrence is still measured. That matters — the acceptance check for this
 * ticket is a drop in error volume, which requires the errors to keep being
 * counted.
 */
export function recoverFromStaleChunk(
  input: { message?: string; stack?: string },
  deps: {
    storage: SentinelStorage | null;
    now: () => number;
    reload: () => void;
  }
): boolean {
  if (!isStaleChunkError(input)) return false;
  if (!claimReloadAttempt(deps.storage, deps.now())) return false;
  deps.reload();
  return true;
}

/** Browser-wired convenience used by the global handlers. */
export function recoverFromStaleChunkInBrowser(input: {
  message?: string;
  stack?: string;
}): boolean {
  if (typeof window === "undefined") return false;
  let storage: SentinelStorage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null; // Blocked storage → no sentinel → no reload. See above.
  }
  return recoverFromStaleChunk(input, {
    storage,
    now: () => Date.now(),
    reload: () => window.location.reload(),
  });
}
