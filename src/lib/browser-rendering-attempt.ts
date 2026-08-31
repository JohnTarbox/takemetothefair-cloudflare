/**
 * OPE-694 — count every Browser Rendering attempt, not just the ones that fail
 * on both paths.
 *
 * Today a BR attempt leaves a record only when the STANDARD path also failed
 * ("Fetch failed both paths: standard=… br=…"). So a fallback that never fires
 * and a fallback that always fails look identical from the outside, and that
 * ambiguity is the whole reason OPE-694 exists: the ticket reported BR as
 * "0-for-2 with no success since 2026-07-19" when what the data actually
 * supported was "not exercised".
 *
 * ── What the record settled, and why it matters here ─────────────────────
 *
 * All three recorded 422s are `2026-08-17 23:53`, `2026-08-24 11:56` and
 * `2026-08-24 14:01:49`. The documented remedy — passing explicit `gotoOptions`
 * instead of relying on the API default, per Cloudflare's own 422 FAQ — shipped
 * in `7c41fb63` and **deployed 2026-08-24 14:37:56Z**. Every 422 on record
 * predates it, the most recent by 36 minutes.
 *
 * So Browser Rendering has not been attempted once since the fix. Its state is
 * **unmeasured, not broken** — and the difference is the difference between
 * needing an operator with a Cloudflare token and needing one more attempt.
 * This makes the next attempt speak for itself.
 *
 * Deliberately `level: "info"` and best-effort. An attempt log must never fail
 * the fetch it is describing, and a successful escalation is not an error —
 * recording it as one would train the reader to ignore the line.
 */
import { logError } from "@/lib/logger";

/** Stable prefix so a count is one `LIKE`, not a regex over free text. */
export const BR_ATTEMPT_PREFIX = "[browser-rendering] attempt";

export interface BrowserRenderingAttempt {
  url: string;
  /** Why the standard path gave up — the condition that triggered escalation. */
  trigger: "status-escalation" | "empty-extraction";
  ok: boolean;
  /** HTTP status from the BR API, when there was one. */
  status?: number | null;
  /** `FetchOutcome.error`, which since PR #1018 carries the API's own detail. */
  error?: string | null;
}

/**
 * Record one attempt and its outcome.
 *
 * Never throws: wrapped so a logging failure cannot turn a working fetch into a
 * failed one. That is not defensiveness for its own sake — this function exists
 * to make a rare path measurable, and a measurement that can break the thing it
 * measures would be worse than the blindness it replaces.
 */
export async function recordBrowserRenderingAttempt(
  db: Parameters<typeof logError>[0],
  attempt: BrowserRenderingAttempt
): Promise<void> {
  try {
    await logError(db, {
      level: "info",
      source: "browser-rendering:attempt",
      message: `${BR_ATTEMPT_PREFIX} ${attempt.ok ? "ok" : "failed"} (${attempt.trigger})`,
      context: {
        url: attempt.url,
        trigger: attempt.trigger,
        ok: attempt.ok,
        status: attempt.status ?? null,
        // The API's own words, not just the status. A status code is not a
        // diagnosis — the lesson PR #1018 recorded when it stopped discarding
        // this body.
        error: attempt.error ?? null,
      },
    });
  } catch {
    // Swallowed on purpose. See the doc comment.
  }
}
