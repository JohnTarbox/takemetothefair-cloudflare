/**
 * OPE-815 — what a stale-page finding is actually evidence OF.
 *
 * The radar's confidence was `Math.min(1, |driftDays| / 30)` — drift magnitude,
 * rescaled. Read from source at `capture.ts`, confirming the ticket's inference.
 *
 * That conflates two different quantities:
 *
 *   "the two dates differ"     — which drift magnitude does measure
 *   "OUR date is the wrong one" — which is what the column is used for
 *
 * And it inverts the second. Measured across the 18 open rows: the 364d, 366d
 * and 729d findings all scored **1.0**, the maximum. A drift of almost exactly
 * one or two years is the signature of *the source still holding a prior year's
 * listing* — the least informative case about our own data, scored highest. The
 * 2d and 4d rows scored 0.067 and 0.133, and a 2-day drift is the signature of
 * the timezone off-by-one family (OPE-307), which is worth catching.
 *
 * So: drift magnitude stays as a fact in `notes`, and confidence answers the
 * question the consumer is actually asking.
 */

/** Who we are disagreeing with. Only the first is the promoter's problem. */
export type ComparisonTarget = "organizer" | "aggregator" | "unknown";

/** Strip scheme, `www.`, port and trailing dot so two hosts compare honestly. */
function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  try {
    h = new URL(h.includes("://") ? h : `https://${h}`).hostname;
  } catch {
    return null;
  }
  h = h.replace(/^www\./, "").replace(/\.$/, "");
  return h || null;
}

/**
 * Is the page we disagreed with the organizer's own site, or a third party?
 *
 * The signal quality splits cleanly on this line. Of the 18 open rows, the 3
 * organizer-domain findings ran **2 of 3 true** on hand verification, while the
 * 15 aggregator findings are where the noise lives — including four rows that
 * are the same recurring series matched to different occurrences, i.e. an
 * internal series-matching problem reported as an external date conflict.
 *
 * ⚠️ `unknown` is deliberately NOT treated as organizer. We only claim a page is
 * the promoter's when we can show it: no promoter website on file means we
 * cannot, and a finding we cannot attribute must not become an email.
 */
export function classifyComparisonTarget(
  comparedUrl: string | null | undefined,
  promoterWebsite: string | null | undefined
): ComparisonTarget {
  const target = normalizeHost(comparedUrl);
  const promoter = normalizeHost(promoterWebsite);
  if (!target) return "unknown";
  if (!promoter) return "unknown";
  if (target === promoter) return "organizer";
  // A subdomain of the promoter's own site is still the organizer
  // (events.example.org vs example.org).
  if (target.endsWith(`.${promoter}`) || promoter.endsWith(`.${target}`)) return "organizer";
  return "aggregator";
}

/**
 * A drift of ~1 or ~2 years: the source is holding a prior year's listing.
 *
 * Its own category rather than the top of a continuous scale. ±10 days of
 * slack because annual events move to the nearest weekend — "first Saturday in
 * October" lands 364, 365 or 371 days later depending on the year.
 */
export function isPriorYearDrift(driftDays: number): boolean {
  const d = Math.abs(driftDays);
  return (d >= 355 && d <= 375) || (d >= 720 && d <= 740);
}

/**
 * Confidence that OUR stored date is the one that is wrong.
 *
 * Not drift magnitude. The ordering this produces, and why:
 *
 *   organizer + prior-year   0.85  their own page still advertises last year.
 *                                  Nearly always true, and the one class that
 *                                  is safe to raise with a promoter — the claim
 *                                  is purely about THEIR page, so it holds
 *                                  whether or not our date is right.
 *   organizer + small drift  0.55  a real disagreement with the people who
 *                                  would know. Worth a look, not self-evident.
 *   aggregator + prior-year  0.15  a third-party listing nobody updated. Says
 *                                  almost nothing about our data. This is the
 *                                  case that used to score 1.0.
 *   aggregator + small drift 0.30  weak, but the off-by-one family (OPE-307)
 *                                  lives here and used to score 0.067.
 *
 * ⚠️ Note the two inversions relative to the old formula: prior-year drift on an
 * aggregator falls from 1.0 to 0.15, and small drift rises. That is the point —
 * the old scale sorted the queue almost exactly backwards.
 */
export function stalePageConfidence(driftDays: number, target: ComparisonTarget): number {
  const priorYear = isPriorYearDrift(driftDays);
  if (target === "organizer") return priorYear ? 0.85 : 0.55;
  if (target === "aggregator") return priorYear ? 0.15 : 0.3;
  // Unknown target: we cannot say whose page it is, so we cannot say much.
  return priorYear ? 0.2 : 0.25;
}
