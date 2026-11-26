/**
 * OPE-1635 — feed analytics 4/5: safe rule changes. The pure half of
 * `backtest_feed_rules` and of the CI fixture gate.
 *
 * Every rule fix risks a new silent miss: the OHTM tuning that dropped kids'
 * programs is what later dropped Marshfield's markets (OPE-1629). So a change
 * to the inclusion rules or the matcher is replayed over a corpus of real feed
 * items first, and the result says exactly what flips — with each flipped
 * item's ground-truth label, when one exists.
 *
 * Labels (OPE-1634) carry an EXPECTATION about inclusion:
 *   keep — approved, missed_match (it was one of our listings), false_drop
 *   drop — rejected, correct_drop
 *   wrong_match says nothing about inclusion (it is a matcher label).
 * The newest inclusion-bearing label wins, so a reviewer who changes their
 * mind is not counted twice.
 *
 * A flip is WRONG-WAY when the proposed verdict contradicts the item's label.
 * The CI gate fails on any wrong-way flip; the tool reports them first.
 */
import type { FeedEvent } from "./feed-event";
import { decideInclusion, inclusionRuleKey, type FeedInclusionRules } from "./inclusion";
import {
  dateNameMatch,
  DEFAULT_MATCHER_SETTINGS,
  type FeedMatcherSettings,
  type MatchCandidate,
} from "./matcher";

export type InclusionExpectation = "keep" | "drop";

const KEEP_LABELS = new Set(["approved", "missed_match", "false_drop"]);
const DROP_LABELS = new Set(["rejected", "correct_drop"]);

export interface CorpusLabel {
  label: string;
  /** Epoch ms; the newest inclusion-bearing label decides. */
  at: number;
}

/** The inclusion a label set expects, or null when no label speaks to it. */
export function labelExpectation(labels: CorpusLabel[]): InclusionExpectation | null {
  let best: CorpusLabel | null = null;
  for (const l of labels) {
    if (!KEEP_LABELS.has(l.label) && !DROP_LABELS.has(l.label)) continue;
    if (!best || l.at >= best.at) best = l;
  }
  if (!best) return null;
  return KEEP_LABELS.has(best.label) ? "keep" : "drop";
}

export interface CorpusItem {
  itemId: string;
  feedId: string;
  /** Which version of the item this is (`latest` or a history capture time). */
  version: string;
  event: FeedEvent;
  /** OPE-1682 — the promoter's camps/workshops opt-in was active. */
  campsWorkshopsOptIn: boolean;
  labels: CorpusLabel[];
}

export interface RuleSet {
  /** Rules for an item's feed. Lets a baseline use each feed's own stored rules. */
  rulesFor: (item: CorpusItem) => FeedInclusionRules;
}

export interface InclusionFlip {
  item_id: string;
  feed_id: string;
  version: string;
  title: string;
  start_date: string | null;
  url: string | null;
  before: { included: boolean; reason: string; rule: string | null };
  after: { included: boolean; reason: string; rule: string | null };
  /** The item's label expectation, or null when unlabelled. */
  expected: InclusionExpectation | null;
  /** The proposed verdict contradicts the label. */
  wrong_way: boolean;
}

export interface RateEstimate {
  value: number | null;
  numerator: number;
  denominator: number;
  formula: string;
  reason?: string;
}

const rate = (num: number, den: number, formula: string, emptyReason: string): RateEstimate =>
  den === 0
    ? { value: null, numerator: 0, denominator: 0, formula, reason: emptyReason }
    : { value: Math.round((num / den) * 1000) / 1000, numerator: num, denominator: den, formula };

export interface InclusionEstimates {
  precision: RateEstimate;
  false_drop_rate: RateEstimate;
}

/** Precision and false-drop rate of one set of verdicts, over LABELLED items. */
export function estimateInclusion(
  rows: Array<{ included: boolean; expected: InclusionExpectation | null }>
): InclusionEstimates {
  const lab = rows.filter((r) => r.expected);
  const inc = lab.filter((r) => r.included);
  const drop = lab.filter((r) => !r.included);
  return {
    precision: rate(
      inc.filter((r) => r.expected === "keep").length,
      inc.length,
      "labelled keep ∩ included / labelled ∩ included",
      "no labelled item is included under these rules"
    ),
    false_drop_rate: rate(
      drop.filter((r) => r.expected === "keep").length,
      drop.length,
      "labelled keep ∩ dropped / labelled ∩ dropped",
      "no labelled item is dropped under these rules"
    ),
  };
}

export interface InclusionBacktest {
  /** Positive landmark: how many item versions were replayed, and how many carry a label. */
  examined: { items: number; versions: number; labelled: number };
  to_dropped: InclusionFlip[];
  to_included: InclusionFlip[];
  wrong_way: InclusionFlip[];
  unchanged: { included: number; dropped: number };
  before: InclusionEstimates;
  after: InclusionEstimates;
}

export function backtestInclusion(
  corpus: CorpusItem[],
  baseline: RuleSet,
  proposed: RuleSet
): InclusionBacktest {
  const toDropped: InclusionFlip[] = [];
  const toIncluded: InclusionFlip[] = [];
  const beforeRows: Array<{ included: boolean; expected: InclusionExpectation | null }> = [];
  const afterRows: typeof beforeRows = [];
  const unchanged = { included: 0, dropped: 0 };
  for (const item of corpus) {
    const opts = { campsWorkshopsOptIn: item.campsWorkshopsOptIn };
    const b = decideInclusion(item.event, baseline.rulesFor(item), opts);
    const a = decideInclusion(item.event, proposed.rulesFor(item), opts);
    const expected = labelExpectation(item.labels);
    // Estimates count the LATEST version only: a label judges the item as it is now.
    if (item.version === "latest") {
      beforeRows.push({ included: b.included, expected });
      afterRows.push({ included: a.included, expected });
    }
    if (b.included === a.included) {
      unchanged[a.included ? "included" : "dropped"]++;
      continue;
    }
    const flip: InclusionFlip = {
      item_id: item.itemId,
      feed_id: item.feedId,
      version: item.version,
      title: item.event.title,
      start_date: item.event.startDate,
      url: item.event.url,
      before: { included: b.included, reason: b.reason, rule: inclusionRuleKey(b.reason) },
      after: { included: a.included, reason: a.reason, rule: inclusionRuleKey(a.reason) },
      expected,
      wrong_way: expected != null && (expected === "keep") !== a.included,
    };
    (a.included ? toIncluded : toDropped).push(flip);
  }
  return {
    examined: {
      items: new Set(corpus.map((c) => c.itemId)).size,
      versions: corpus.length,
      labelled: corpus.filter((c) => c.version === "latest" && labelExpectation(c.labels)).length,
    },
    to_dropped: toDropped,
    to_included: toIncluded,
    wrong_way: [...toDropped, ...toIncluded].filter((f) => f.wrong_way),
    unchanged,
    before: estimateInclusion(beforeRows),
    after: estimateInclusion(afterRows),
  };
}

/**
 * Every LABELLED item whose verdict under `rules` contradicts its label — the
 * CI gate's check (no baseline needed: the labels ARE the baseline).
 */
export function labelViolations(
  corpus: CorpusItem[],
  rules: RuleSet
): Array<{ item_id: string; title: string; expected: InclusionExpectation; reason: string }> {
  const out = [];
  for (const item of corpus) {
    const expected = labelExpectation(item.labels);
    if (!expected) continue;
    const v = decideInclusion(item.event, rules.rulesFor(item), {
      campsWorkshopsOptIn: item.campsWorkshopsOptIn,
    });
    if ((expected === "keep") !== v.included) {
      out.push({ item_id: item.itemId, title: item.event.title, expected, reason: v.reason });
    }
  }
  return out;
}

// ── matcher ───────────────────────────────────────────────────────────────

export interface MatcherCorpusItem {
  itemId: string;
  feedId: string;
  title: string;
  startDate: string | null;
  /** The item's current link, and how it was made (OPE-1634 link_basis). */
  eventId: string | null;
  linkBasis: string | null;
  unlinkedEventId: string | null;
  labels: CorpusLabel[];
  /** The promoter's listings — the date + name match's candidate set. */
  candidates: MatchCandidate[];
}

export interface MatchChange {
  item_id: string;
  feed_id: string;
  title: string;
  start_date: string | null;
  before: string | null;
  after: string | null;
  /** The item's current link (any basis) — what a reviewer has accepted or set. */
  current_event_id: string | null;
  current_link_basis: string | null;
  labels: string[];
}

export interface MatcherBacktest {
  examined: { items: number; with_start_date: number };
  gained: MatchChange[];
  lost: MatchChange[];
  changed: MatchChange[];
  /**
   * Gained matches that agree with a link a reviewer made (missed_match) — the
   * change would have caught a miss — and lost matches that pointed at an event
   * a reviewer unlinked (wrong_match) — it would have avoided an error.
   */
  confirmed_by_labels: { gained_agrees_with_review_link: number; lost_was_unlinked: number };
}

/**
 * Replays the date + name match only — the one matcher step with settings.
 * Items whose link came from somewhere else (prior, source_url, a reviewer)
 * are still replayed: the question is what THIS step would say.
 */
export function backtestMatcher(
  corpus: MatcherCorpusItem[],
  baseline: FeedMatcherSettings = DEFAULT_MATCHER_SETTINGS,
  proposed: FeedMatcherSettings = DEFAULT_MATCHER_SETTINGS
): MatcherBacktest {
  const gained: MatchChange[] = [];
  const lost: MatchChange[] = [];
  const changed: MatchChange[] = [];
  let agrees = 0;
  let avoided = 0;
  for (const it of corpus) {
    const b = dateNameMatch(it, it.candidates, baseline, it.unlinkedEventId);
    const a = dateNameMatch(it, it.candidates, proposed, it.unlinkedEventId);
    if (a === b) continue;
    const row: MatchChange = {
      item_id: it.itemId,
      feed_id: it.feedId,
      title: it.title,
      start_date: it.startDate,
      before: b,
      after: a,
      current_event_id: it.eventId,
      current_link_basis: it.linkBasis,
      labels: it.labels.map((l) => l.label),
    };
    if (!b) {
      gained.push(row);
      if (it.linkBasis === "review_link" && it.eventId === a) agrees++;
    } else if (!a) {
      lost.push(row);
      if (it.unlinkedEventId === b) avoided++;
    } else changed.push(row);
  }
  return {
    examined: {
      items: corpus.length,
      with_start_date: corpus.filter((c) => c.startDate).length,
    },
    gained,
    lost,
    changed,
    confirmed_by_labels: { gained_agrees_with_review_link: agrees, lost_was_unlinked: avoided },
  };
}

/**
 * The default rules as they stood BEFORE OPE-1629 (#1780, 2026-11-12), in the
 * current engine's terms: the seven original title includes, and a program word
 * in the DESCRIPTION drops on its own (`programDescriptionSignals: ["(?:)"]`,
 * a pattern that always matches), which is what the pre-1629 combined
 * title + description test did. Kept so a backtest can replay that fix, and as
 * the change log's first entry's "before".
 *
 * NOT `""`: `decideInclusion` tests the MATCHED PATTERN for truthiness, and the
 * empty string is falsy, so `[""]` silently never fires — a backtest with it
 * reports zero flips for a change that flipped seven items. `(?:)` matches
 * everything and is truthy.
 */
export const PRE_OPE1629_INCLUSION_RULES: Partial<FeedInclusionRules> = {
  includeTitlePatterns: ["festival", "fair", "show", "airshow", "jamboree", "rally", "auction"],
  programDescriptionSignals: ["(?:)"],
};
