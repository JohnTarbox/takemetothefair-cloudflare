/**
 * OPE-1505 — recognise an event we already list from an email's TEXT alone.
 *
 * The specimen: inbound `01ad5525`, a forwarded organizer confirmation for the
 * Manchester Grange Fall Craft Fair. No link, no attachment. The only matcher
 * that existed tried single subject words — "manchester", then "grange" — found
 * each one in more than one event name, called both ambiguous and gave up. It
 * never asked whether one event's WHOLE name was in the email, and never looked
 * at the date ("Saturday October 24th") or the town. Audit comments on
 * OPE-1057 counted match-to-existing at 0/3, 0/18, 0/1.
 *
 * The question this module asks instead is per EVENT, not per word:
 *
 *   "What fraction of this event's distinctive name tokens appear anywhere in
 *    the email?"
 *
 * "Alexander Hamfest 2026" → {alexander, hamfest}: both are in the Hamfest
 * email's body, while "Hermon Hamfest" has only half its name there. A fair we
 * do NOT list ("Readfield Grange Craft Fair") shares one token with Manchester
 * Grange's name and is refused, because one shared word is exactly the
 * evidence that failed before.
 *
 * Then date and place break ties between editions of the same series — the
 * normal case in this corpus, not a contrived one: the Lobster Festival
 * newsletter names the festival, and only "Aug. 4-8, 2027" separates the 2027
 * edition from the 2026 one.
 *
 * A match is accepted only when ONE candidate clearly leads. Every call returns
 * its candidates and scores, matched or not, so a failure can be counted and a
 * probe can see when matching never succeeds (Ask 5).
 *
 * Read-only. This module never writes, and a match never changes an event's
 * name, dates or venue (OPE-457 / OPE-537): it only says which listing an email
 * is about.
 */
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { events, venues, promoters, eventNameVariants } from "../schema.js";
import type { Db } from "../db.js";
import { distinctiveTokens, subjectToEventQuery } from "./vendor-inquiry-briefing.js";

/** Share of an event's distinctive name tokens the email must contain. With
 *  names of two or more tokens this already means at least two shared words —
 *  one shared word is not evidence. A ONE-token name is held to its whole
 *  phrase instead (see scoreCandidates). */
export const MIN_NAME_CONTAINMENT = 0.6;
/** The leader must beat the runner-up by at least this much. */
export const MIN_LEAD = 0.25;
/** "Upcoming" for ranking purposes (a ranking preference, never a filter). */
export const UPCOMING_WINDOW_DAYS = 120;

const DAY = 86_400;

export type TextMatchOutcome =
  | "matched"
  | "ambiguous" // two or more candidates pass, none clearly leads
  | "below-threshold" // candidates were found, none names enough of the event
  | "no-candidate" // the retrieval found no event at all
  | "no-query"; // the email carries no distinctive word to search on

export interface TextMatchCandidateInput {
  id: string;
  slug: string;
  name: string;
  /** Other names for the event (`event_name_variants`). */
  variants: string[];
  /** Unix seconds, as D1 stores them. */
  startDate: number | null;
  endDate: number | null;
  city: string | null;
  promoterName: string | null;
}

export interface ScoredCandidate {
  id: string;
  slug: string;
  name: string;
  startDate: string | null;
  score: number;
  nameContainment: number;
  eligible: boolean;
  reasons: string[];
}

export interface TextMatchResult {
  outcome: TextMatchOutcome;
  matched: ScoredCandidate | null;
  /** Top three by score, eligible or not — the "why" when nothing matched. */
  candidates: ScoredCandidate[];
  /** The tokens retrieval searched on. */
  searched: string[];
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/** Header lines of a quoted forward ("Date: Tue, Sep 15, 2026") name the
 *  FORWARD's date, not the event's — a date boost from one would be noise. */
const FORWARD_HEADER_LINE = /^\s*>?\s*(from|date|sent|to|cc|subject):.*$/gim;

/** Lower-case words joined by single spaces — for whole-phrase containment. */
function norm(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Every (month, day) the text names: "October 24th", "Sep 19", "Aug. 4-8". */
export function mentionedMonthDays(text: string): Set<string> {
  const out = new Set<string>();
  const body = text.replace(FORWARD_HEADER_LINE, " ");
  const re =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
  for (const m of body.matchAll(re)) {
    const mon = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3) as (typeof MONTHS)[number]);
    const day = Number(m[2]);
    if (mon >= 0 && day >= 1 && day <= 31) out.add(`${mon + 1}-${day}`);
  }
  return out;
}

/** Years named in the body (forward headers excluded, for the same reason). */
export function mentionedYears(text: string): Set<number> {
  const body = text.replace(FORWARD_HEADER_LINE, " ");
  return new Set([...body.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])));
}

/** The event-name phrases worth searching on: the subject, plus every quoted
 *  `Subject:` line of a forward and the first short line of the message. */
export function nameQueries(subject: string | null, bodyText: string | null): string[] {
  const out = [subjectToEventQuery(subject)];
  const body = bodyText ?? "";
  for (const m of body.matchAll(/^\s*>?\s*subject:\s*(.+)$/gim)) {
    out.push(subjectToEventQuery(m[1]));
  }
  const firstLine = body
    .replace(FORWARD_HEADER_LINE, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^-+\s*forwarded message/i.test(l));
  if (firstLine && firstLine.length <= 80) out.push(subjectToEventQuery(firstLine));
  return [...new Set(out.filter((q) => q.length > 0))];
}

/** A name's identifying tokens, with years and ordinals dropped. */
function nameTokens(name: string): string[] {
  return distinctiveTokens(name.replace(/\b\d+(st|nd|rd|th)\b/gi, " ")).filter(
    (t) => !/^(19|20)\d{2}$/.test(t)
  );
}

/**
 * Pure scoring — no I/O, so every threshold is unit-testable.
 *
 * Score = name containment (primary) + date and place evidence (tie-breakers).
 * Eligibility depends on the NAME only: a date or a town can rank two editions
 * of a fair the email names, but can never promote a fair it does not name.
 */
export function scoreCandidates(
  input: { subject: string | null; bodyText: string | null; receivedAt: number },
  candidates: TextMatchCandidateInput[]
): ScoredCandidate[] {
  const text = `${input.subject ?? ""}\n${input.bodyText ?? ""}`;
  const textWords = words(text.replace(FORWARD_HEADER_LINE, " "));
  // Subject words count even though the subject is not in the body: a forward's
  // own "Subject:" header is the most deliberate name in the message.
  for (const w of words(subjectToEventQuery(input.subject))) textWords.add(w);
  for (const q of nameQueries(input.subject, input.bodyText)) {
    for (const w of words(q)) textWords.add(w);
  }
  const monthDays = mentionedMonthDays(text);
  const years = mentionedYears(text);
  const lowerText = ` ${norm(text)} `;

  return candidates.map((c) => {
    const reasons: string[] = [];
    let best = 0;
    let bestMatched = 0;
    let bestName = c.name;
    for (const n of [c.name, ...c.variants]) {
      const toks = nameTokens(n);
      if (toks.length === 0) continue;
      const hit = toks.filter((t) => textWords.has(t)).length;
      let containment = hit / toks.length;
      // A one-token name ("Fryeburg Fair") counts only when its WHOLE phrase
      // is in the text — the single token alone is one shared word.
      if (toks.length === 1 && hit === 1) {
        const phrase = norm(n.replace(/\b(19|20)\d{2}\b/g, " "));
        if (!phrase.includes(" ") || !lowerText.includes(` ${phrase} `)) containment = 0;
      }
      if (containment > best || (containment === best && hit > bestMatched)) {
        best = containment;
        bestMatched = hit;
        bestName = n;
      }
    }
    const eligible = best >= MIN_NAME_CONTAINMENT;
    reasons.push(
      `name ${Math.round(best * 100)}% (${bestMatched} token${bestMatched === 1 ? "" : "s"}${bestName !== c.name ? `, via variant "${bestName}"` : ""})`
    );

    let score = best;
    if (c.startDate != null) {
      const start = new Date(c.startDate * 1000);
      const end = c.endDate != null ? new Date(c.endDate * 1000) : start;
      // Any day of the run counts: "Aug. 4-8" names the 4th.
      for (
        let t = start.getTime();
        t <= end.getTime() && t - start.getTime() < 31 * DAY * 1000;
        t += DAY * 1000
      ) {
        const d = new Date(t);
        if (monthDays.has(`${d.getUTCMonth() + 1}-${d.getUTCDate()}`)) {
          score += 0.5;
          reasons.push(`date ${d.toISOString().slice(0, 10)} named in text`);
          break;
        }
      }
      if (years.has(start.getUTCFullYear())) {
        score += 0.2;
        reasons.push(`year ${start.getUTCFullYear()} named`);
      }
      const endSec = c.endDate ?? c.startDate;
      if (endSec < input.receivedAt - DAY) {
        score -= 0.5;
        reasons.push("already over when the email arrived");
      } else if (c.startDate <= input.receivedAt + UPCOMING_WINDOW_DAYS * DAY) {
        score += 0.3;
        reasons.push(`upcoming within ${UPCOMING_WINDOW_DAYS}d`);
      }
    }
    if (c.city && lowerText.includes(` ${norm(c.city)} `)) {
      score += 0.3;
      reasons.push(`town "${c.city}" named`);
    }
    if (c.promoterName) {
      const p = norm(c.promoterName);
      if (p.length >= 6 && lowerText.includes(` ${p} `)) {
        score += 0.3;
        reasons.push(`promoter "${c.promoterName}" named`);
      }
    }
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      startDate:
        c.startDate != null ? new Date(c.startDate * 1000).toISOString().slice(0, 10) : null,
      score: Math.round(score * 100) / 100,
      nameContainment: Math.round(best * 100) / 100,
      eligible,
      reasons,
    };
  });
}

/** Pure decision over scored candidates. */
export function decideTextMatch(scored: ScoredCandidate[], searched: string[]): TextMatchResult {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top3 = sorted.slice(0, 3);
  if (searched.length === 0)
    return { outcome: "no-query", matched: null, candidates: [], searched };
  if (sorted.length === 0)
    return { outcome: "no-candidate", matched: null, candidates: [], searched };
  const eligible = sorted.filter((c) => c.eligible);
  if (eligible.length === 0) {
    return { outcome: "below-threshold", matched: null, candidates: top3, searched };
  }
  const [lead, next] = eligible;
  if (next && lead.score - next.score < MIN_LEAD) {
    return { outcome: "ambiguous", matched: null, candidates: top3, searched };
  }
  return { outcome: "matched", matched: lead, candidates: top3, searched };
}

/** Bounded retrieval: per token, at most this many rows. */
const PER_TOKEN_LIMIT = 40;
/** Editions older than this cannot be what a new email is about. */
const LOOKBACK_DAYS = 60;
const LOOKAHEAD_DAYS = 550;

/**
 * Find the existing event an email is about, from its subject and body text.
 * Never throws for a no-match; throws only on a DB error (callers fail soft).
 */
export async function matchEventFromText(
  db: Db,
  input: { subject: string | null; bodyText: string | null; receivedAt: number }
): Promise<TextMatchResult> {
  const searched = [
    ...new Set(nameQueries(input.subject, input.bodyText).flatMap((q) => distinctiveTokens(q))),
  ].slice(0, 6);
  if (searched.length === 0) return decideTextMatch([], searched);

  // Raw seconds: D1 date columns are unix SECONDS, and `end_date` may be NULL
  // on a one-day event, so the window reads coalesce(end, start).
  const fromSec = input.receivedAt - LOOKBACK_DAYS * DAY;
  const toSec = input.receivedAt + LOOKAHEAD_DAYS * DAY;
  const live = and(
    isNull(events.mergedInto),
    notInArray(events.status, ["DRAFT", "REJECTED"]),
    sql`coalesce(${events.endDate}, ${events.startDate}) >= ${fromSec}`,
    sql`${events.startDate} <= ${toSec}`
  );

  const ids = new Set<string>();
  for (const token of searched) {
    const byName = await db
      .select({ id: events.id })
      .from(events)
      .where(and(live, sql`instr(lower(${events.name}), ${token}) > 0`))
      .limit(PER_TOKEN_LIMIT);
    for (const r of byName) ids.add(r.id);
    const byVariant = await db
      .select({ id: eventNameVariants.eventId })
      .from(eventNameVariants)
      .innerJoin(events, eq(events.id, eventNameVariants.eventId))
      .where(and(live, sql`instr(lower(${eventNameVariants.variant}), ${token}) > 0`))
      .limit(PER_TOKEN_LIMIT);
    for (const r of byVariant) ids.add(r.id);
  }
  if (ids.size === 0) return decideTextMatch([], searched);

  // ≤ 6 tokens × 2 × 40 = 480 ids worst case: chunk under D1's 100-param cap.
  const all = [...ids];
  const rows: TextMatchCandidateInput[] = [];
  for (let i = 0; i < all.length; i += 90) {
    const chunk = all.slice(i, i + 90);
    const evs = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        startDate: events.startDate,
        endDate: events.endDate,
        city: venues.city,
        promoterName: promoters.companyName,
      })
      .from(events)
      .leftJoin(venues, eq(venues.id, events.venueId))
      .leftJoin(promoters, eq(promoters.id, events.promoterId))
      .where(inArray(events.id, chunk));
    const vars = await db
      .select({ eventId: eventNameVariants.eventId, variant: eventNameVariants.variant })
      .from(eventNameVariants)
      .where(inArray(eventNameVariants.eventId, chunk));
    for (const e of evs) {
      rows.push({
        id: e.id,
        slug: e.slug,
        name: e.name,
        variants: vars.filter((v) => v.eventId === e.id).map((v) => v.variant),
        startDate: e.startDate ? Math.floor(e.startDate.getTime() / 1000) : null,
        endDate: e.endDate ? Math.floor(e.endDate.getTime() / 1000) : null,
        city: e.city,
        promoterName: e.promoterName,
      });
    }
  }
  return decideTextMatch(scoreCandidates(input, rows), searched);
}
