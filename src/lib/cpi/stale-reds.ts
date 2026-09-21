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
import { isParked, isTerminalStatus } from "@/lib/faults/status";

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
  /**
   * OPE-1096 — collapse key for the DIGEST only.
   *
   * A fault signature is per (route, error) by design (OPE-1081), so one
   * incident across N routes yields N signals. That is right for diagnosis and
   * wrong as N lines of an email: on 2026-09-12 two D1 failures across 135
   * routes produced 135 bullets. Signals sharing a `groupKey` render as one
   * line naming the route count.
   *
   * Deliberately NOT applied at selection: the action queue and the push
   * fingerprint keep seeing one entry per route, so this changes presentation
   * and nothing about what is tracked.
   */
  groupKey?: string;
  /** OPE-1096 — how many signals this digest line represents. Set by grouping. */
  groupCount?: number;
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
  /** OPE-1096 — ms-epoch of the most recent occurrence. */
  lastSeen: number;
  /** OPE-1096 — the digest groups by this; the signature stays per-route. */
  errorClass: string;
}

/**
 * OPE-1096 — a fault that has not recurred in this long is no longer an
 * ongoing outage, whatever its age-in-red says.
 *
 * `hoursInRed` is measured from `firstSeen` and grows forever, so before this
 * a signature stayed red from its first occurrence until a human resolved it.
 * On 2026-09-12 two D1 query failures fanned across **135 distinct routes**,
 * each minting its own per-route signature. They stopped the same day. Nine
 * days later all 135 were still counted, and the daily digest read
 * **"239 dashboard signals stuck red"** at 43,601 characters — 224 of them
 * render faults, burying roughly ten real signals that had been flat at 8–15
 * for six weeks.
 *
 * 7 days = **7× the 24h P0 escalation leash**, so this is a generous reading of
 * "still happening", not a tight one. Measured against prod at the moment of
 * choosing: no filter 235 · 14d 210 · **7d 51** · 48h 19 · 24h 2.
 *
 * ⚠️ 14d was rejected on the numbers, and the reason is worth keeping: the
 * dominant incident was only 9 days old, so a fortnight's window still admitted
 * all of it and changed 235 → 210. A round-number window can look reasonable
 * and do nothing.
 */
const FAULT_RECURRENCE_WINDOW_DAYS = 7;

/**
 * OPE-1096 — a fault still firing within two escalation windows is outage-class;
 * one last seen five days ago is real but is not an outage.
 *
 * Every render fault used to be hardcoded P0, which is why 227 of 239 signals
 * carried it. A priority 95% of rows share cannot rank anything.
 */
const FAULT_P0_RECENCY_HOURS = 48;

/**
 * Which faults can go stale-red.
 *
 * ⚠️ OPE-811 — was a hand-rolled set omitting `open` (8 production rows) and
 * `watch` (2). Because `filed` and `regressed` have no rows in prod, the
 * escalation path could only ever see `proposed` signatures.
 *
 * `watch` is excluded deliberately and permanently: it means an operator parked
 * the row on purpose. Escalating a parked row is how an alert channel earns its
 * mute, and a muted channel is how the original defect survived 15 days.
 */
function isStaleEligible(status: string): boolean {
  return !isTerminalStatus(status) && !isParked(status);
}

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
    if (!isStaleEligible(row.status)) continue; // settled or parked → not stale
    if (Number.isNaN(row.firstSeen)) continue; // guard bad stamp, never throw

    // OPE-1096 — has it actually recurred lately? A NaN `lastSeen` is treated
    // as stale rather than fresh: an unreadable stamp must not be a free pass
    // into a P0 digest.
    const daysSinceSeen = Number.isNaN(row.lastSeen)
      ? Number.POSITIVE_INFINITY
      : (nowMs - row.lastSeen) / MS_PER_HOUR / 24;
    if (daysSinceSeen > FAULT_RECURRENCE_WINDOW_DAYS) continue;

    const hoursInRed = (nowMs - row.firstSeen) / MS_PER_HOUR;
    if (hoursInRed > thresholdHours) {
      const hoursSinceSeen = daysSinceSeen * 24;
      stale.push({
        priority: hoursSinceSeen <= FAULT_P0_RECENCY_HOURS ? "P0" : "P1",
        title: `Render fault: ${row.route ?? row.signature}`,
        refKey: row.signature,
        // Deep-link to the OPE-83 tile anchor on the analytics overview.
        href: "/admin/analytics#render-fault-health",
        // Excluded from the push fingerprint — see the field's doc comment.
        volatileSignature: true,
        firstDetectedAt: new Date(row.firstSeen).toISOString(),
        hoursInRed,
        groupKey: row.errorClass,
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
 * OPE-1096 — one line per error class, for the digest only.
 *
 * Signals carrying a `groupKey` are collapsed: the line names the class and how
 * many routes it covers, and takes the highest priority and longest age in the
 * group. Signals without a `groupKey` (every non-fault red) pass through
 * untouched — which is what keeps the ~10 KPI, queue-freeze and heartbeat
 * signals visible instead of being suppressed alongside the noise.
 *
 * `n === 1` is left as its own title on purpose: "Render fault: /events/x" is
 * more useful than "<error class> — 1 route".
 */
export function groupForDigest(reds: StaleRed[]): StaleRed[] {
  const out: StaleRed[] = [];
  const seen = new Map<string, number>(); // groupKey → index in `out`

  for (const r of reds) {
    if (!r.groupKey) {
      out.push(r);
      continue;
    }
    const at = seen.get(r.groupKey);
    if (at === undefined) {
      seen.set(r.groupKey, out.length);
      out.push({ ...r });
      continue;
    }
    const head = out[at];
    const count = (head.groupCount ?? 1) + 1;
    out[at] = {
      ...head,
      groupCount: count,
      // Highest priority in the group wins: one actively-firing route makes the
      // class outage-class, and hiding that behind a calmer sibling is the
      // failure this ticket is about.
      priority: head.priority === "P0" || r.priority === "P0" ? "P0" : "P1",
      hoursInRed: Math.max(head.hoursInRed, r.hoursInRed),
      title: `${r.groupKey} — ${count} routes`,
    };
  }
  return out;
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
  // OPE-1096 — collapse signals sharing a `groupKey` into one line. Order is
  // preserved from `reds` (already sorted longest-red first), so a group takes
  // the position of its oldest member.
  const grouped = groupForDigest(reds);

  // OPE-1096 — the subject counts LINES, not signals, because the subject is a
  // promise about the body. It read "239 dashboard signals stuck red" over a
  // body of 239 bullets, 135 of which were one incident; counting signals
  // while printing groups would be a subject that disagrees with its own email.
  const n = grouped.length;
  const signalCount = reds.length;
  // OPE-261 §4 — hrefs are resolved, not concatenated. Signals whose href is
  // already absolute (the IndexNow red links out to Bing Webmaster Tools)
  // previously rendered as `https://meetmeatthefair.comhttps://…` and did not
  // resolve at all.
  const base = baseUrl.replace(/\/+$/, "");
  const subject = `⚠️ ${n} dashboard signal${n === 1 ? "" : "s"} stuck red`;

  const intro =
    `${n} action-queue signal${n === 1 ? " has" : "s have"} been red past the escalation ` +
    `threshold (P0 > ${STALE_THRESHOLD_HOURS.P0}h, P1 > ${STALE_THRESHOLD_HOURS.P1}h).` +
    // Say so when lines < signals, so a collapsed incident is visible as one
    // rather than silently hidden.
    (signalCount > n ? ` ${signalCount} underlying signals, grouped by error.` : "");
  // OPE-308 — this used to say "daily … keeps nagging", which stopped being
  // true once the scan moved to pushing on change. Describe what actually
  // happens, so an operator can read the arrival of this mail as a signal in
  // itself rather than as background noise.
  const outro =
    "You are getting this because the set of stale-red signals CHANGED. A signal " +
    "that is simply still red does not re-send — Monday's inventory covers whatever " +
    "is still standing. Render faults are listed here but do not trigger a send on " +
    "their own, because their signatures rotate.";

  const textLines = grouped.map(
    (r) =>
      `• [${r.priority}] ${r.title} — red ${formatAge(r.hoursInRed)}\n  ${resolveDigestHref(base, r.href)}`
  );
  const text = [intro, "", ...textLines, "", outro].join("\n");

  const htmlItems = grouped
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
