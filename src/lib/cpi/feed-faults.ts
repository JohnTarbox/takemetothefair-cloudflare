/**
 * OPE-1636 — feed fault families on the CPI rail.
 *
 * The CPI drain (`/api/internal/cpi/fileable-signals`) reports every family's
 * counts as `feedFaultFamilies` (informational — counting never files), and
 * turns AT MOST ONE family into a fileable signal: the top family in the window,
 * once it reaches FEED_FAULT_FILE_THRESHOLD. That one signal is the family's
 * prevention ticket. It goes through the same reconcile/dedup/rate-cap ledger
 * as every other signal (fingerprint `cpi:feed:<family>`), and resolves itself
 * when the family drops back below the threshold or another family overtakes it.
 *
 * Why only the top family: seven families each filing at a low count would
 * swamp the 5-per-run rate cap with feed noise. The retro reads every count;
 * the rail files the one worth preventing first.
 *
 * PURE — no db, no I/O.
 */
import type { FeedFaultReport } from "@takemetothefair/db-schema/feed-fault-families";
import type { ActionQueueEntry } from "@/lib/analytics-overview/types";

const MS_PER_HOUR = 3_600_000;

export function feedFaultActionEntry(report: FeedFaultReport, now: Date): ActionQueueEntry | null {
  const top = report.top;
  if (!top || !top.fileable) return null;
  const fam = report.families.find((f) => f.id === top.id);
  if (!fam) return null;
  const firstDetectedAt = fam.first_seen_at;
  const hoursInRed =
    firstDetectedAt != null ? (now.getTime() - Date.parse(firstDetectedAt)) / MS_PER_HOUR : null;
  return {
    priority: "P1",
    source: "feed",
    title: `Feed fault family ${fam.id}: ${fam.count_window} in ${report.window_days}d — ${fam.title}; file a prevention ticket`,
    effort: "",
    href: "/admin/feed-review",
    firstDetectedAt,
    refKey: fam.id,
    hoursInRed,
    slaStatus: "red",
  };
}
