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
  severity: "ERROR";
  /** Human-readable, e.g. `FAIL: Missing field "location" [Events]`. */
  message: string;
}

export function summarizeRichResults(
  rr: UrlInspectionResult["richResults"] | undefined
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

  return { failing: true, severity: "ERROR", message: `${verdict}: ${detail}${more}` };
}
