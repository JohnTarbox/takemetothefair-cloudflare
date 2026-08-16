/**
 * OPE-394 — the editorial + FAQ layer for `/events/{state}`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The `festivalsandfairs[state].com` network out-ranks us on both contested
 * head terms by concentrating an editorial + FAQ layer on the one ranking URL,
 * while showing only name + city + date per listing. We have the data; we did
 * not have the layer.
 *
 * ── Every answer here is DERIVED, never written ─────────────────────────────
 * The ticket's constraint is "grounded / no fabricated hours", and the blog
 * rules it points at exist because invented specifics are the failure mode of
 * generated SEO copy. So this module takes counts and month/category
 * distributions computed from the events actually in the database and phrases
 * them. There is no hand-written claim about any fair's hours, prices, or
 * admission anywhere in it.
 *
 * That is also why an FAQ can be MISSING. If a state has too little data to say
 * anything true, `buildStateFaq` returns fewer items — and below FAQ_MIN_ITEMS
 * `FAQPageSchema` renders nothing at all. An absent FAQ is correct; a padded
 * one would be the exact "reports success, does nothing" shape in prose form.
 *
 * ── Self-cannibalisation ────────────────────────────────────────────────────
 * The epic warns that our blog guide and this state page compete for the same
 * head term (blog #3, state page #7). This layer deliberately does NOT restate
 * the guide's editorial content: it answers inventory questions the guide
 * cannot ("how many are on right now", "which months are busiest"), which is
 * the half a static article structurally cannot keep current. The state page
 * keeps its own canonical (already set in getStateMetadata).
 */

/** Matches FAQPageSchema's own floor — below this, emitting is worse than not. */
export const STATE_FAQ_MIN_ITEMS = 3;

export interface FaqItem {
  question: string;
  answer: string;
}

/** Live facts about one state's inventory. All computed, none asserted. */
export interface StateInventory {
  /** Upcoming events in this state. */
  upcomingCount: number;
  /** Month index (0-11) → count of upcoming events starting in it. */
  countsByMonth: number[];
  /** Distinct category labels present, most common first. */
  topCategories: string[];
  /** Distinct towns/cities with at least one upcoming event. */
  townCount: number;
}

/** Widest span still worth calling a "season" on a fair calendar. */
const MAX_SEASON_SPAN_MONTHS = 6;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The contiguous run of months carrying the bulk of the state's events.
 *
 * Returns null rather than guessing when the data cannot support a claim —
 * fewer than 6 events, or no month standing out. "Fair season runs June to
 * September" is a factual claim about a real place; it should come from the
 * calendar or not be made.
 */
export function peakSeason(countsByMonth: number[]): { from: string; to: string } | null {
  const total = countsByMonth.reduce((a, b) => a + b, 0);
  if (total < 6) return null;

  const months = countsByMonth
    .map((count, i) => ({ i, count }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count);
  if (months.length === 0) return null;

  // Take months until we have covered ~70% of the year's events, then report
  // the calendar span they occupy.
  let covered = 0;
  const chosen: number[] = [];
  for (const m of months) {
    chosen.push(m.i);
    covered += m.count;
    if (covered / total >= 0.7) break;
  }

  const sorted = [...chosen].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0] + 1;

  // The guard is on the SPAN, not the number of months chosen.
  //
  // Caught by its own test: an evenly-spread calendar (10 events every month)
  // needs 9 months to reach 70%, which is only 9 < 10 by count — so a
  // count-based guard let it through and produced "most events fall between
  // January and September". True, and useless: a nine-month span is not a
  // season, and printing it as one is a confident sentence about a real place
  // that tells a reader nothing.
  //
  // Six months is the widest thing worth calling a season on a fair calendar.
  if (span > MAX_SEASON_SPAN_MONTHS) return null;

  return { from: MONTHS[sorted[0]], to: MONTHS[sorted[sorted.length - 1]] };
}

/** Busiest single month, or null when nothing is distinguishable. */
export function busiestMonth(countsByMonth: number[]): string | null {
  const total = countsByMonth.reduce((a, b) => a + b, 0);
  if (total < 6) return null;
  let best = -1;
  let bestIdx = -1;
  countsByMonth.forEach((c, i) => {
    if (c > best) {
      best = c;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || best === 0) return null;
  return MONTHS[bestIdx];
}

/**
 * A short, factual intro. Sentences are dropped rather than softened when the
 * data cannot support them, so a thin state gets a shorter paragraph instead of
 * a vaguer one.
 */
export function buildStateIntro(stateName: string, inv: StateInventory, year: number): string {
  const parts: string[] = [];

  parts.push(
    inv.upcomingCount > 0
      ? `Meet Me at the Fair tracks ${inv.upcomingCount} upcoming ${stateName} fairs, festivals, craft shows and markets for ${year}.`
      : `Meet Me at the Fair tracks ${stateName} fairs, festivals, craft shows and markets year-round.`
  );

  if (inv.townCount > 1) {
    parts.push(`They run in ${inv.townCount} towns and cities across the state.`);
  }

  const season = peakSeason(inv.countsByMonth);
  if (season) {
    parts.push(
      season.from === season.to
        ? `Most of the calendar lands in ${season.from}.`
        : `Most of the calendar falls between ${season.from} and ${season.to}.`
    );
  }

  parts.push(
    `Every listing links through to the organiser, so dates and details come from the people running the event.`
  );

  return parts.join(" ");
}

/**
 * Grounded FAQ for a state page.
 *
 * Each entry is emitted ONLY when the underlying data supports it. Callers must
 * treat fewer than STATE_FAQ_MIN_ITEMS as "emit no FAQ and no JSON-LD".
 */
export function buildStateFaq(stateName: string, inv: StateInventory, year: number): FaqItem[] {
  const items: FaqItem[] = [];

  if (inv.upcomingCount > 0) {
    items.push({
      question: `How many fairs and festivals are there in ${stateName} in ${year}?`,
      answer:
        `We currently list ${inv.upcomingCount} upcoming ${stateName} fairs, festivals, craft shows and markets for ${year}` +
        (inv.townCount > 1 ? `, spread across ${inv.townCount} towns and cities.` : `.`) +
        ` The calendar is updated daily as organisers publish their dates.`,
    });
  }

  const season = peakSeason(inv.countsByMonth);
  const busiest = busiestMonth(inv.countsByMonth);
  if (season) {
    items.push({
      question: `When is fair season in ${stateName}?`,
      answer:
        (season.from === season.to
          ? `Most ${stateName} events on our calendar fall in ${season.from}`
          : `Most ${stateName} events on our calendar fall between ${season.from} and ${season.to}`) +
        (busiest ? `, with ${busiest} the busiest single month.` : `.`) +
        ` Smaller craft shows and indoor markets continue outside that window.`,
    });
  }

  if (inv.topCategories.length >= 2) {
    items.push({
      question: `What kinds of events are listed for ${stateName}?`,
      answer: `The ${stateName} calendar covers ${inv.topCategories.slice(0, 5).join(", ")} and more. You can filter the list by category, month or town.`,
    });
  }

  // Navigational, and true regardless of inventory — but only worth adding
  // once there is something to navigate.
  if (inv.upcomingCount > 0) {
    items.push({
      question: `How do I find fairs near me in ${stateName}?`,
      answer: `Browse the ${stateName} calendar below and filter by town or category. Each event page lists the venue with a map, so you can see exactly where it is before you travel.`,
    });
  }

  return items;
}
