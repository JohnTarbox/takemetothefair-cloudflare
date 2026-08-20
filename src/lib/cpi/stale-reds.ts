/**
 * OPE-75 — CPI Move 1: stale-red detection for the §6.3 action queue.
 *
 * The /admin/analytics action queue is pull-only: a P0/P1 signal can sit red
 * for weeks and nothing escalates. Proof it's needed — IndexNow was dead for
 * 2+ weeks and the dashboard card showed it the whole time, but no one was
 * pushed. This module is the pure, testable heart of the self-escalating loop:
 * given the current action-queue entries, pick the ones that have been red
 * past a priority-specific threshold and format a factual operator digest.
 * The internal scan endpoint + daily MCP cron drive it (once-daily cadence).
 */

import type { ActionQueueEntry } from "@/lib/analytics-overview/types";
import { resolveDigestHref } from "@takemetothefair/utils";

export interface StaleRed {
  priority: "P0" | "P1";
  title: string;
  refKey: string;
  href: string;
  firstDetectedAt: string;
  hoursInRed: number;
  /**
   * OPE-308 — this red belongs in the digest BODY but must not, on its own,
   * trigger a send. Set only by `selectStaleFaultReds`: a render-fault refKey
   * is `route#message` where the message is the browser's own error text, so
   * its identity changes when the error text changes. Membership therefore
   * churns without anything on our side moving. See `staleRedFingerprint`.
   */
  volatileSignature?: boolean;
}

/**
 * Hours a signal may sit red before it counts as "stale" and worth escalating.
 * P0 gets a tight 24h leash (an outage-class signal); P1 a looser 72h (a
 * degradation we still want fixed but not paged on same-day). Ticket-specified.
 */
export const STALE_THRESHOLD_HOURS: Record<"P0" | "P1", number> = {
  P0: 24,
  P1: 72,
};

const MS_PER_HOUR = 3_600_000;

/**
 * For each entry with a non-null `firstDetectedAt`, compute how long it's been
 * red and keep it when that exceeds the threshold for its priority. Entries
 * with a null (or unparseable) stamp are excluded — no age means it can't be
 * "stale". Sorted P0 first, then longest-festering first within a priority.
 * Never throws.
 */
export function selectStaleReds(entries: ActionQueueEntry[], now: Date): StaleRed[] {
  const nowMs = now.getTime();
  const stale: StaleRed[] = [];

  for (const entry of entries) {
    if (!entry.firstDetectedAt) continue; // no age → can't be "stale"
    const firstMs = new Date(entry.firstDetectedAt).getTime();
    if (Number.isNaN(firstMs)) continue; // unparseable stamp → skip, never throw

    const hoursInRed = (nowMs - firstMs) / MS_PER_HOUR;
    if (hoursInRed > STALE_THRESHOLD_HOURS[entry.priority]) {
      stale.push({
        priority: entry.priority,
        title: entry.title,
        refKey: entry.refKey,
        href: entry.href,
        firstDetectedAt: entry.firstDetectedAt,
        hoursInRed,
      });
    }
  }

  stale.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "P0" ? -1 : 1;
    return b.hoursInRed - a.hoursInRed; // longest red first within a priority
  });
  return stale;
}

/**
 * OPE-83 — render faults feeding the same stale-red escalation.
 *
 * A render fault that crashes a route on every load is outage-class: it must
 * escalate by email if it sits unresolved, exactly like a stale KPI red. This
 * maps unresolved `fault_signatures` rows (the OPE-81 ledger) into the shared
 * `StaleRed` shape so the OPE-75 scan can merge them with the action-queue reds
 * and drive ONE digest.
 */
export interface FaultRedInput {
  signature: string;
  route: string | null;
  status: string;
  firstSeen: number; // ms-epoch
}

/** Statuses that count as still-open — a `done` fault is resolved, never stale. */
const OPEN_FAULT_STATUSES = new Set(["proposed", "filed", "regressed"]);

/**
 * Pick the UNRESOLVED render faults that have been open past `thresholdHours`
 * and map them to P0 StaleReds (render faults are outage-class, so they default
 * to the tight P0 24h leash). Rows with a resolved status or a NaN `firstSeen`
 * are skipped — pure, never throws. Sorted longest-red first.
 */
export function selectStaleFaultReds(
  rows: FaultRedInput[],
  now: Date,
  thresholdHours: number = STALE_THRESHOLD_HOURS.P0
): StaleRed[] {
  const nowMs = now.getTime();
  const stale: StaleRed[] = [];

  for (const row of rows) {
    if (!OPEN_FAULT_STATUSES.has(row.status)) continue; // resolved → not stale
    if (Number.isNaN(row.firstSeen)) continue; // guard bad stamp, never throw

    const hoursInRed = (nowMs - row.firstSeen) / MS_PER_HOUR;
    if (hoursInRed > thresholdHours) {
      stale.push({
        priority: "P0",
        title: `Render fault: ${row.route ?? row.signature}`,
        refKey: row.signature,
        // Deep-link to the OPE-83 tile anchor on the analytics overview.
        href: "/admin/analytics#render-fault-health",
        // Excluded from the push fingerprint — see the field's doc comment.
        volatileSignature: true,
        firstDetectedAt: new Date(row.firstSeen).toISOString(),
        hoursInRed,
      });
    }
  }

  stale.sort((a, b) => b.hoursInRed - a.hoursInRed); // longest red first
  return stale;
}

/**
 * Human-friendly age label: hours while under two days, whole days beyond. The
 * digest reports days-or-hours, not a raw float, so an operator can scan it.
 */
function formatAge(hoursInRed: number): string {
  const hours = Math.round(hoursInRed);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hoursInRed / 24)}d`;
}

/**
 * Build the operator digest for the currently-stale signals. Factual, no PII:
 * per signal we surface its priority, title, days/hours-in-red, and a deep link
 * (`${baseUrl}${href}`). `ActionQueueEntry` doesn't carry the current-value or
 * target strings, so title + priority + age + link is the full available shape.
 */
export function formatStaleRedDigest(
  reds: StaleRed[],
  baseUrl: string
): { subject: string; text: string; html: string } {
  const n = reds.length;
  // OPE-261 §4 — hrefs are resolved, not concatenated. Signals whose href is
  // already absolute (the IndexNow red links out to Bing Webmaster Tools)
  // previously rendered as `https://meetmeatthefair.comhttps://…` and did not
  // resolve at all.
  const base = baseUrl.replace(/\/+$/, "");
  const subject = `⚠️ ${n} dashboard signal${n === 1 ? "" : "s"} stuck red`;

  const intro =
    `${n} action-queue signal${n === 1 ? " has" : "s have"} been red past the escalation ` +
    `threshold (P0 > ${STALE_THRESHOLD_HOURS.P0}h, P1 > ${STALE_THRESHOLD_HOURS.P1}h).`;
  // OPE-308 — this used to say "daily … keeps nagging", which stopped being
  // true once the scan moved to pushing on change. Describe what actually
  // happens, so an operator can read the arrival of this mail as a signal in
  // itself rather than as background noise.
  const outro =
    "You are getting this because the set of stale-red signals CHANGED. A signal " +
    "that is simply still red does not re-send — Monday's inventory covers whatever " +
    "is still standing. Render faults are listed here but do not trigger a send on " +
    "their own, because their signatures rotate.";

  const textLines = reds.map(
    (r) =>
      `• [${r.priority}] ${r.title} — red ${formatAge(r.hoursInRed)}\n  ${resolveDigestHref(base, r.href)}`
  );
  const text = [intro, "", ...textLines, "", outro].join("\n");

  const htmlItems = reds
    .map(
      (r) =>
        `<li><strong>[${r.priority}]</strong> ${r.title} — red ${formatAge(r.hoursInRed)} ` +
        `(<a href="${resolveDigestHref(base, r.href)}">open</a>)</li>`
    )
    .join("");
  const html = `<p>${intro}</p><ul>${htmlItems}</ul><p>${outro}</p>`;

  return { subject, text, html };
}

/**
 * OPE-308 — a stable identity for "which reds are currently red".
 *
 * The scan used to mail whenever `allReds.length > 0`, i.e. on EXISTENCE. A red
 * that persisted therefore mailed the operator every day — the same
 * "re-notify a persistent condition daily" pattern OPE-305 removed from the
 * discrepancy queue. The fix is to push on CHANGE instead, and change is
 * defined here.
 *
 * Deliberately the sorted refKey SET and nothing else: membership is the news.
 * Including hoursInRed would make the fingerprint move every single scan (the
 * clock always advances), which reintroduces the daily mail through the back
 * door while looking like change detection. Sorting means the digest's own
 * ordering cannot fake a change either.
 *
 * ...and `volatileSignature` reds are excluded, because the first cut of this
 * still mailed near-daily. Measured 2026-08-20 over the send ledger: the digest
 * count oscillated 11/12/13/14 day to day while the eight non-fault reds had
 * not moved since 08-16. Every swing was render-fault signatures rotating —
 * their refKey embeds the browser's error text, so a reworded message is a new
 * member. Eight standing problems were invisible behind that churn.
 *
 * They stay in the digest body (`formatStaleRedDigest` gets the full set); they
 * just no longer decide WHEN it is sent. The cost is accepted deliberately: a
 * brand-new client-side error waits for the Monday inventory rather than
 * paging same-day. That was the explicit ruling on OPE-308 — a JS error on
 * /login is not the same class of news as a frozen queue.
 */
export function staleRedFingerprint(
  reds: Pick<StaleRed, "refKey" | "volatileSignature">[]
): string {
  return reds
    .filter((r) => !r.volatileSignature)
    .map((r) => r.refKey)
    .sort()
    .join("|");
}
