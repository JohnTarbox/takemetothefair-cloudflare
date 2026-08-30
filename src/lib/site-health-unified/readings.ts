/**
 * OPE-391 — turning each instrument's report into a verdict reading.
 *
 * Pure. Every threshold decision lives here rather than in JSX, so the policy
 * is reviewable in one place and testable without a database.
 *
 * ── Why there is no "open discrepancies > N" threshold ────────────────────
 *
 * The obvious rule would be an absolute cap — the CPI phase-0 exit condition
 * of roughly 45 open rows. That number lives in `cpi.config.yaml`, which is
 * NOT in this repository (it sits in the analyst workspace on another
 * machine), so it cannot be read from source here. Hard-coding a remembered
 * constant to gate a health verdict is precisely what OPE-6 v3.1 forbids, and
 * a copy of it here would silently drift from the original.
 *
 * The trend answers the more useful question anyway. "Is the queue draining?"
 * is self-referential — it needs no external constant, and a growing queue is
 * the actual failure whatever the absolute number is. A queue at 300 and
 * falling is healthier than one at 60 and climbing.
 */
import type { InstrumentReading } from "./verdict";
import type { DataHealthReport } from "./data-health";
import type { TrafficReport } from "./traffic";

export interface TechnicalCounts {
  errorCount: number;
  warningCount: number;
  richResultFailCount: number;
}

export function technicalReading(counts: TechnicalCounts): InstrumentReading {
  const { errorCount, warningCount, richResultFailCount } = counts;
  const actionItems = errorCount + warningCount;

  // Expected non-indexing rows and snoozed rows are deliberately absent from
  // these counts — they are supplied already filtered by the tab, which is the
  // same ACTION-tier split the issue tables use. A verdict that counted the
  // expected pile would read "104 action items" forever and be ignored.
  let detail: string;
  if (actionItems === 0) {
    detail = "no open technical defects";
  } else if (richResultFailCount > 0) {
    detail = `${richResultFailCount} page${richResultFailCount === 1 ? "" : "s"} failing rich-result validation`;
    const others = actionItems - richResultFailCount;
    if (others > 0) detail += ` and ${others} other technical issue${others === 1 ? "" : "s"}`;
  } else {
    detail = `${actionItems} technical issue${actionItems === 1 ? "" : "s"}`;
  }

  return {
    key: "technical",
    label: "Technical / SEO",
    severity: errorCount > 0 ? "critical" : warningCount > 0 ? "attention" : "ok",
    actionItems,
    detail,
    href: "/admin/analytics?tab=site-health#technical",
  };
}

export function dataReading(report: DataHealthReport): InstrumentReading {
  const first = report.trend[0];
  const last = report.trend[report.trend.length - 1];
  const growing = first != null && last != null && last.openCount > first.openCount;

  // A stale snapshot does not make the LIVE counts unknown — those are queried
  // now. It makes the trend untrustworthy, which is what the severity reflects.
  if (report.snapshotStale) {
    const age = report.latestSnapshotAgeDays;
    return {
      key: "data",
      label: "Data health",
      severity: "attention",
      actionItems: report.liveOpen,
      detail:
        age === null
          ? `${report.liveOpen} open discrepancies; no health snapshot has ever been written`
          : `${report.liveOpen} open discrepancies; nightly snapshot is ${age} days stale`,
      href: "/admin/analytics?tab=site-health#data-health",
    };
  }

  return {
    key: "data",
    label: "Data health",
    severity: growing ? "attention" : "ok",
    actionItems: report.liveOpen,
    detail: growing
      ? `${report.liveOpen} open discrepancies, up from ${first!.openCount} over ${report.trend.length} days`
      : `${report.liveOpen} open discrepancies, not growing`,
    href: "/admin/analytics?tab=site-health#data-health",
  };
}

export function trafficReading(report: TrafficReport): InstrumentReading {
  // GA4 unreachable or unconfigured. NOT zero sessions — see traffic.ts.
  if (report.current === null) {
    return {
      key: "traffic",
      label: "Traffic",
      severity: "unknown",
      actionItems: null,
      detail: "GA4 did not return organic sessions",
      href: "/admin/analytics?tab=overview",
    };
  }

  // A week-over-week fall of more than a quarter is worth a person's
  // attention; smaller swings are noise on a site this size. Seasonality is
  // real here (fair season), so this deliberately does not escalate to
  // critical — it prompts a look, it does not declare an outage.
  const CONCERN_DROP = -0.25;
  const dropping = report.deltaPct !== null && report.deltaPct <= CONCERN_DROP;
  const pct = report.deltaPct === null ? null : Math.round(report.deltaPct * 100);

  return {
    key: "traffic",
    label: "Traffic",
    severity: dropping ? "attention" : "ok",
    actionItems: dropping ? 1 : 0,
    detail: dropping
      ? `organic sessions down ${Math.abs(pct!)}% week over week (${report.current} vs ${report.previous})`
      : pct === null
        ? `${report.current} organic sessions`
        : `${report.current} organic sessions, ${pct >= 0 ? "+" : ""}${pct}% week over week`,
    href: "/admin/analytics?tab=overview",
  };
}
