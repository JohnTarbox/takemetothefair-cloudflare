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

/** sessionStorage key holding `"<attempts>:<lastEpochMs>"` for this tab. */
export const CHUNK_RELOAD_SENTINEL = "mmatf:stale-chunk-reload-at";

/**
 * webpack's `output.chunkLoadTimeout`, in ms. Not configured in
 * `next.config.mjs`, so this is the bundled default, read from source:
 * `node_modules/next/dist/compiled/webpack/bundle5.js` → `D(v,"chunkLoadTimeout",12e4)`.
 *
 * Recorded as a named constant because the cooldown below is DERIVED from it.
 * If Next ever changes the default, the derivation is what must be re-checked,
 * and a bare 60_000 gave nobody anything to re-check.
 */
export const WEBPACK_CHUNK_LOAD_TIMEOUT_MS = 120_000;

/**
 * Minimum gap between two recovery attempts in one tab.
 *
 * ## OPE-550 — why this is 10 minutes and was 60 seconds
 *
 * At 60s this sentinel could not stop a loop, and did not: one iPhone spent
 * **4h21m** reloading `/blog/gun-shows-in-maine-2026-…` 40 times. Measured gaps
 * between consecutive errors, from `error_logs`:
 *
 *     22:18:26 → 22:20:27 → 22:22:28 → 22:24:29 → 22:26:31
 *        121s       121s       121s       122s
 *
 * That is `WEBPACK_CHUNK_LOAD_TIMEOUT_MS` plus a reload round-trip, and it is
 * the whole mechanism: the chunk request STALLS rather than failing, webpack
 * gives up after 120s, and by then the 60s cooldown has long since expired —
 * so the next reload is permitted, and restarts the same doomed download.
 *
 * The cooldown was structurally incapable of blocking a timeout-driven loop,
 * because it was exactly half the timeout. The original comment reasoned that
 * "60s is far longer than a reload round-trip, so a loop is blocked on its
 * second iteration" — true for a `missing:` chunk, which fails in milliseconds,
 * and false for a `timeout:` chunk, which cannot fail in under 120s by
 * definition.
 *
 * ⚠️ The 121s regularity also FALSIFIES the reported hypothesis that the
 * sentinel was failing open on iOS Safari. A sentinel that never persisted
 * would loop at reload speed — one to two seconds. Metronomic 121s gaps are
 * proof the sentinel was being written and read correctly on every iteration.
 * It worked perfectly and permitted the loop anyway.
 *
 * 10 minutes is 5× the timeout, so no stalled-chunk cycle can outrun it, while
 * still being far shorter than the gap between two deploys.
 */
export const RELOAD_COOLDOWN_MS = 10 * 60_000;

/**
 * Absolute per-tab ceiling on recovery reloads, regardless of the cooldown.
 *
 * The cooldown alone bounds the RATE, not the TOTAL: at one reload per 10
 * minutes a persistently stalled connection still produces 24 in four hours.
 * A user is not helped by a 25th attempt, and each one costs them their scroll
 * position and any unsubmitted form state.
 *
 * Three, because a tab here can legitimately outlive several deploys (this
 * repo ships multiple times a day) and each deploy is one genuine incident —
 * but a tab that has already failed to recover three times is not going to.
 * After that the user keeps the error, which is the honest outcome and the one
 * they can act on.
 *
 * ⚠️ Deliberately NOT an in-memory counter, which the ticket suggested. A
 * reload destroys in-memory state, so an in-memory counter is always 0 on the
 * iteration that matters and bounds nothing. The bound has to live in storage
 * precisely because the thing being bounded is a reload.
 */
export const MAX_RELOAD_ATTEMPTS = 3;

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
    const { attempts, lastMs } = readSentinel(storage);
    // OPE-550 — the absolute ceiling is checked FIRST, so it holds even if the
    // clock jumps, the stored timestamp is garbage, or a future edit loosens
    // the cooldown.
    if (attempts >= MAX_RELOAD_ATTEMPTS) return false;
    if (lastMs !== null && nowMs - lastMs < RELOAD_COOLDOWN_MS) return false;
    storage.setItem(CHUNK_RELOAD_SENTINEL, `${attempts + 1}:${nowMs}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the sentinel into an attempt count and the last attempt time.
 *
 * Tolerates the pre-OPE-550 format (a bare epoch-ms with no count) so a tab
 * open across the deploy is not handed a fresh budget: an unparseable or
 * legacy value counts as one attempt already spent, which errs toward fewer
 * reloads. Every unreadable state resolves in the safe direction.
 */
function readSentinel(storage: SentinelStorage): { attempts: number; lastMs: number | null } {
  const raw = storage.getItem(CHUNK_RELOAD_SENTINEL);
  if (raw === null) return { attempts: 0, lastMs: null };

  const [countPart, timePart] = raw.split(":");
  if (timePart === undefined) {
    // Legacy: a bare timestamp.
    const legacy = Number.parseInt(countPart, 10);
    return { attempts: 1, lastMs: Number.isFinite(legacy) ? legacy : null };
  }
  const attempts = Number.parseInt(countPart, 10);
  const lastMs = Number.parseInt(timePart, 10);
  return {
    attempts: Number.isFinite(attempts) && attempts >= 0 ? attempts : MAX_RELOAD_ATTEMPTS,
    lastMs: Number.isFinite(lastMs) ? lastMs : null,
  };
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
