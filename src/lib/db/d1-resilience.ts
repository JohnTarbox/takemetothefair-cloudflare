/**
 * OPE-790 — absorb a Cloudflare-side D1 blip instead of turning it into an outage.
 *
 * Three D1 platform resets in seven days (2026-08-27, 08-28, 09-02) each took
 * the whole public browse surface to the error boundary. None was our SQL: the
 * OPE-84 scan correctly ruled all three "not a code defect". We cannot stop
 * them, we get them roughly weekly, and until now we had no answer to them.
 *
 * The 08-27 incident lasted **one second**. A single retry would have absorbed
 * it whole, and the user would never have known.
 *
 * ## Only PLATFORM faults are retried, and that distinction is the point
 *
 * Retrying a query defect is worse than not retrying: `too many columns in
 * result set` fails identically the second time, so the only effect is to pay
 * the latency twice and double the error rows. The classifier below exists so a
 * retry is spent exclusively on the faults that a retry can actually fix.
 *
 * ## READS ONLY — do not wrap a write in this
 *
 * A retried write can apply twice. D1 gives no idempotency token, and a
 * "storage operation exceeded timeout" is entirely consistent with a statement
 * that COMMITTED and then failed to report success. That is why this is scoped
 * to the page-level `getX` read fetchers and why the name says so. A write that
 * needs this needs a different mechanism (an idempotency key), not this one.
 *
 * ## What this deliberately does NOT change
 *
 * When a retry does not help, the fetcher still throws `FetchError` and the
 * error boundary still renders. That is REL1' §1 (2026-06-04), which chose the
 * throw over `return <empty default>` because the 100-column outage went 17
 * hours undetected — the empty list was byte-identical to a real zero-result
 * filter. Swapping the throw for an empty result would re-create exactly that.
 * OPE-790 scopes 1–2 ask for the swap; the conflict is recorded on the ticket
 * rather than resolved unilaterally here.
 */

/** What kind of failure this is, and therefore whether a retry can help. */
export type D1FaultClass =
  /** Cloudflare-side. Transient by nature; a retry is worth one attempt. */
  | "platform_transient"
  /** Our SQL. Deterministic — retrying only pays the cost twice. */
  | "query_defect"
  /** Not recognisably either. Treated as non-retryable. */
  | "unknown";

/**
 * Substrings that identify a Cloudflare-side D1 fault, lowercased.
 *
 * Every entry is a string OBSERVED in `error_logs`, not one imagined for
 * completeness — the first three are the exact shapes of the 08-27, 08-28 and
 * 09-02 incidents in OPE-790's own table.
 */
const PLATFORM_TRANSIENT_MARKERS = [
  "exceeded its cpu time limit",
  "storage operation exceeded timeout",
  "internal error in d1 db storage",
  "object to be reset",
  "network connection lost",
  "d1_error: connection",
] as const;

/**
 * Substrings that identify OUR query as the problem. Checked FIRST, because
 * some of these arrive wrapped in a generic `D1_ERROR:` envelope that would
 * otherwise look platform-shaped.
 */
const QUERY_DEFECT_MARKERS = [
  "too many columns in result set",
  "too many sql variables",
  "sqlite_error",
  "unique constraint failed",
  "foreign key constraint failed",
  "no such column",
  "like or glob pattern too complex",
] as const;

/** Flatten an error (and its `cause` chain) to one lowercased haystack. */
function errorText(e: unknown, depth = 0): string {
  if (depth > 4 || e == null) return "";
  if (typeof e === "string") return e.toLowerCase();
  if (e instanceof Error) {
    // `cause` matters: FetchError wraps the original D1 exception, so the
    // marker we need is one level down and invisible to `String(e)`.
    return `${e.message} ${errorText((e as { cause?: unknown }).cause, depth + 1)}`.toLowerCase();
  }
  return String(e).toLowerCase();
}

export function classifyD1Error(e: unknown): D1FaultClass {
  const text = errorText(e);
  if (!text) return "unknown";
  if (QUERY_DEFECT_MARKERS.some((m) => text.includes(m))) return "query_defect";
  if (PLATFORM_TRANSIENT_MARKERS.some((m) => text.includes(m))) return "platform_transient";
  return "unknown";
}

export const D1_RETRY_BASE_DELAY_MS = 120;
export const D1_RETRY_JITTER_MS = 180;

export interface D1RetryOutcome {
  /** True when the first attempt failed and a retry was made. */
  retried: boolean;
  /** Classification of the FIRST failure, when there was one. */
  firstFaultClass?: D1FaultClass;
  /** True when the retry succeeded — i.e. a blip was absorbed. */
  recovered: boolean;
}

/**
 * Run a READ once; on a platform-transient D1 fault, wait a jittered moment and
 * run it exactly once more.
 *
 * One retry, not a loop. A retry storm against a D1 instance that is already
 * timing out is how a blip becomes a longer blip, and the incidents this was
 * built for resolved on their own in seconds.
 *
 * The jitter is not decoration: every page on the browse surface fails at the
 * same instant during a reset, so an unjittered retry would send the whole
 * surface back at D1 simultaneously.
 *
 * `onOutcome` is called before the value is returned (or the error rethrown) so
 * the caller can put the classification in its `logError` context. Degrading
 * quietly is not the goal — `error_logs` is the only oracle we have for these
 * (OPE-574), so an absorbed blip must still be countable.
 */
export async function withD1Read<T>(
  fn: () => Promise<T>,
  onOutcome?: (outcome: D1RetryOutcome) => void
): Promise<T> {
  try {
    const value = await fn();
    onOutcome?.({ retried: false, recovered: false });
    return value;
  } catch (first) {
    const firstFaultClass = classifyD1Error(first);
    if (firstFaultClass !== "platform_transient") {
      onOutcome?.({ retried: false, firstFaultClass, recovered: false });
      throw first;
    }
    await new Promise((r) =>
      setTimeout(r, D1_RETRY_BASE_DELAY_MS + Math.random() * D1_RETRY_JITTER_MS)
    );
    try {
      const value = await fn();
      onOutcome?.({ retried: true, firstFaultClass, recovered: true });
      return value;
    } catch (second) {
      onOutcome?.({ retried: true, firstFaultClass, recovered: false });
      throw second;
    }
  }
}

/**
 * Record a retry outcome to `error_logs`, and never throw doing it.
 *
 * Scope 4 of OPE-790: degrading gracefully must not make the incident
 * invisible. An absorbed blip produces NO user-visible symptom and no
 * `server-render` row, so without this line it would leave no trace at all —
 * and "the resets stopped" and "we stopped noticing the resets" would look
 * identical. `error_logs` is the only oracle we have here (OPE-574).
 *
 * Logged at `warn`, not `error`: the user got their page. Level `error` is
 * reserved for the case where the retry did not save us, which the fetcher's
 * own catch block already logs.
 */
export async function recordD1RetryOutcome(source: string, outcome: D1RetryOutcome): Promise<void> {
  if (!outcome.retried) return;
  try {
    const { getCloudflareDb } = await import("@/lib/cloudflare");
    const { logError } = await import("@/lib/logger");
    await logError(getCloudflareDb(), {
      level: outcome.recovered ? "warn" : "error",
      message: outcome.recovered
        ? `D1 platform blip absorbed by retry (${source})`
        : `D1 platform fault survived one retry (${source})`,
      source,
      context: {
        d1_fault_class: outcome.firstFaultClass ?? "unknown",
        d1_retried: true,
        d1_recovered: outcome.recovered,
      },
    });
  } catch {
    // A telemetry write must never be the reason a page fails. If error_logs
    // is unreachable it is almost certainly the same D1 fault we are reporting.
  }
}

/** `withD1Read` + `recordD1RetryOutcome`, which is how every caller uses it. */
export function withD1ReadLogged<T>(source: string, fn: () => Promise<T>): Promise<T> {
  return withD1Read(fn, (outcome) => {
    void recordD1RetryOutcome(source, outcome);
  });
}
