/**
 * A10 (2026-06-26) — summarise a GSC URL-Inspection `richResults` block into a
 * health-issue decision.
 *
 * The site-health sweep historically persisted only the `coverageState` half of
 * each inspection and DISCARDED `richResults`, so the 360-error K46 defect
 * ("Missing field 'location'" on every event page) was invisible in our data
 * for two months even though `get_url_inspection` returned it. This pure helper
 * turns the raw block into `{ failing, severity, message }` so the sweep can
 * raise a `GSC_RICH_RESULT_FAIL` row.
 *
 * Failing = the rich result `verdict` is FAIL, OR any enumerated issue is
 * ERROR-severity (a PARTIAL verdict still fails on its ERROR items). NEUTRAL
 * (page not eligible for any rich result) and WARNING-only results are NOT
 * escalated to a health issue — that would flood the dashboard with
 * non-actionable noise; the deploy-time JSON-LD validator + GSC UI cover those.
 */
import type { UrlInspectionResult } from "@/lib/search-console";

export interface RichResultSummary {
  failing: boolean;
  severity: "ERROR" | "INFO";
  /** Human-readable, e.g. `FAIL: Missing field "location" [Events]`. */
  message: string;
  /**
   * OPE-567 — true when the verdict provably describes a version of the page
   * that no longer exists (the page changed after Google last crawled it).
   * Such a row is still REPORTED, at INFO, with the staleness in its message.
   */
  staleVerdict?: boolean;
}

/**
 * OPE-567 — what the caller knows about when Google looked vs when the page
 * last changed. Both optional: absent means "cannot tell", and the verdict is
 * then treated as current.
 */
export interface VerdictFreshness {
  /** `lastCrawlTime` from the same inspection response. */
  lastCrawlTime?: Date | null;
  /** The entity row's `updated_at` for this URL. */
  pageLastChangedAt?: Date | null;
}

/**
 * Is this verdict provably about a version of the page that no longer exists?
 *
 * Exported for tests, and because the decision is the whole point of OPE-567 —
 * it should be readable without reading the summariser around it.
 *
 * ⚠️ Returns false whenever it cannot tell. An unknown date means the verdict
 * stands: reporting a stale ERROR costs someone a re-check, whereas hiding a
 * live one costs the thing the dashboard exists for.
 */
export function isVerdictStale(f: VerdictFreshness | undefined): boolean {
  const crawled = f?.lastCrawlTime;
  const changed = f?.pageLastChangedAt;
  if (!crawled || !changed) return false;
  const c = crawled.getTime();
  const u = changed.getTime();
  if (!Number.isFinite(c) || !Number.isFinite(u)) return false;
  return c < u;
}

export function summarizeRichResults(
  rr: UrlInspectionResult["richResults"] | undefined,
  freshness?: VerdictFreshness
): RichResultSummary | null {
  if (!rr) return null;
  const verdict = (rr.verdict ?? "UNKNOWN").toUpperCase();

  // Flatten every issue across detected rich-result types, tagging with its
  // type so the message reads e.g. `Missing field "location" [Events]`.
  const issues: Array<{ type: string; message: string; severity: string }> = [];
  for (const di of rr.detectedItems ?? []) {
    const type = di.richResultType ?? "Unknown";
    for (const item of di.items ?? []) {
      for (const iss of item.issues ?? []) {
        issues.push({
          type,
          message: iss.issueMessage ?? "(unspecified issue)",
          severity: (iss.severity ?? "").toUpperCase(),
        });
      }
    }
  }

  const errorIssues = issues.filter((i) => i.severity === "ERROR");
  const failing = verdict === "FAIL" || errorIssues.length > 0;
  if (!failing) return null;

  // Prefer the ERROR issues in the message; fall back to whatever issues exist,
  // and to a bare verdict line when Google reported FAIL with no issue list.
  const shown = (errorIssues.length > 0 ? errorIssues : issues).slice(0, 3);
  const detail = shown.length
    ? shown.map((i) => `${i.message} [${i.type}]`).join("; ")
    : "rich result invalid";
  const remaining = issues.length - shown.length;
  const more = remaining > 0 ? ` (+${remaining} more)` : "";

  const base = `${verdict}: ${detail}${more}`;

  // OPE-567 — a GSC verdict describes the LAST CRAWL, not the page. If the row
  // changed after Google looked, this verdict is about a version that no longer
  // exists, and reporting it at ERROR is reporting a fact about the past as if
  // it were actionable now.
  //
  // Measured 2026-08-26: of 52 GSC_RICH_RESULT_FAIL rows ever raised, 47 had
  // already resolved themselves as Google re-crawled and all 5 survivors were
  // ALSO false — every one served a valid `location` when fetched live. A 100%
  // false-positive rate on the dashboard's only ERROR-severity class.
  //
  // Downgraded and ANNOTATED, never suppressed. The row stays visible so a
  // reader can see "Google thinks this is broken and has not looked since X";
  // deleting it would trade a false alarm for a blind spot, which is the
  // failure `[[feedback_suppressing_alert_does_not_fix_state]]` records.
  if (isVerdictStale(freshness)) {
    const crawledOn = freshness!.lastCrawlTime!.toISOString().slice(0, 10);
    const changedOn = freshness!.pageLastChangedAt!.toISOString().slice(0, 10);
    return {
      failing: true,
      severity: "INFO",
      staleVerdict: true,
      message: `STALE VERDICT (last crawled ${crawledOn}, page changed ${changedOn}) — ${base}`,
    };
  }

  return { failing: true, severity: "ERROR", message: base };
}
