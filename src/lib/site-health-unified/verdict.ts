/**
 * OPE-391 — the one-line answer to "is the whole site healthy?".
 *
 * Pure on purpose. Every input is a number somebody else measured, so this
 * file can be exhaustively tested without a database, and the rule it encodes
 * is visible in one screen rather than spread through JSX.
 *
 * ── The rule that matters most: an unmeasured instrument is NOT healthy ────
 *
 * A verdict banner composed from three instruments has one dangerous failure
 * mode, and it is not "shows the wrong count". It is **reading green because
 * an instrument returned nothing.** This project's most-recurring defect class
 * is "shipped but silently not executing" (IndexNow dead a fortnight, OCR a
 * silent no-op, GW1d never scoring a row), and a health page that renders
 * "Healthy" when its data source is down would be the purest possible example
 * of it — the page that exists to catch the failure, hiding it.
 *
 * So `status: "unknown"` is a distinct, LOUD state, and it wins over "healthy"
 * whenever any instrument reports `unknown`. It never wins over a real
 * problem: a known failure elsewhere is still the more actionable headline.
 */

export type InstrumentKey = "technical" | "data" | "traffic";

/**
 * `unknown` is not a severity — it is the absence of a measurement, and the
 * ordering below deliberately places it between `ok` and `attention`. Worse
 * than fine (we cannot claim health), better than a defect we can actually
 * name (that deserves the headline).
 */
export type InstrumentSeverity = "ok" | "unknown" | "attention" | "critical";

const SEVERITY_RANK: Record<InstrumentSeverity, number> = {
  ok: 0,
  unknown: 1,
  attention: 2,
  critical: 3,
};

export interface InstrumentReading {
  key: InstrumentKey;
  label: string;
  severity: InstrumentSeverity;
  /**
   * Count of things a person should act on. NULL when severity is `unknown`
   * — a count of 0 alongside `unknown` would be a lie the summary line then
   * repeats.
   */
  actionItems: number | null;
  /** One clause describing the finding, e.g. "2 pages failing rich results". */
  detail: string;
  /** Where clicking the item goes. */
  href?: string;
}

export type VerdictStatus = "healthy" | "unknown" | "attention" | "critical";

export interface SiteHealthVerdict {
  status: VerdictStatus;
  /** The full sentence to render. Always non-empty. */
  headline: string;
  /** Total action items across instruments that reported one. */
  totalActionItems: number;
  /** Instruments that could not be measured, by label. */
  unmeasured: string[];
  /** Readings that contributed a problem, worst first. */
  problems: InstrumentReading[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Compose the banner.
 *
 * Deliberately does NOT sum `actionItems` into the status. Ten expected
 * non-indexing notices are not worse than one page returning 5xx, and a
 * verdict that ranked them that way would train the reader to ignore it. The
 * status is the worst SEVERITY any instrument reports; the count is context.
 */
export function computeSiteHealthVerdict(
  readings: readonly InstrumentReading[]
): SiteHealthVerdict {
  const unmeasured = readings.filter((r) => r.severity === "unknown").map((r) => r.label);
  const problems = readings
    .filter((r) => r.severity === "attention" || r.severity === "critical")
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const totalActionItems = readings.reduce((sum, r) => sum + (r.actionItems ?? 0), 0);

  const worst = readings.reduce<InstrumentSeverity>(
    (acc, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[acc] ? r.severity : acc),
    "ok"
  );

  // No instruments at all is `unknown`, never `healthy`. An empty array means
  // nothing was measured, which is exactly the case the caller must see.
  if (readings.length === 0) {
    return {
      status: "unknown",
      headline: "No health instruments reported — nothing has been measured.",
      totalActionItems: 0,
      unmeasured: [],
      problems: [],
    };
  }

  const status: VerdictStatus = worst === "ok" ? "healthy" : worst;

  let headline: string;
  if (status === "healthy") {
    headline = "Healthy — no action items across technical, data and traffic.";
  } else if (status === "unknown") {
    headline = `Unverified — ${unmeasured.join(" and ")} did not report. Health cannot be confirmed.`;
  } else {
    const lead = problems.map((p) => p.detail).join("; ");
    const label = status === "critical" ? "Needs attention" : "Attention";
    headline = `${label} — ${plural(totalActionItems, "action item")}: ${lead}.`;
    if (unmeasured.length > 0) {
      headline += ` (${unmeasured.join(" and ")} did not report.)`;
    }
  }

  return { status, headline, totalActionItems, unmeasured, problems };
}
