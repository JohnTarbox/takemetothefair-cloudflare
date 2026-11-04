/**
 * OPE-1316 — choose the honest reply when a submitted link produced no event.
 *
 * Before this, every such email got one reply — "couldn't read the event
 * details … shorteners, redirects, and pages that need JavaScript" — even when
 * the link was the official home page of an event we already list (inbound
 * `1e10e617`, NEAR-Fest), and even when the page had opened fine and only the
 * extraction failed. John's 2026-11-03 ruling splits it three ways:
 *
 *   A. the link IS an event we list           → `already-listed-link`
 *   B. we opened the page, found no event     → `unfetchable-url`, outcome B,
 *                                               and the row is flagged for review
 *                                               (B promises "a person will look")
 *   C. we could not open the page             → `unfetchable-url`, outcome C
 *
 * ⚠️ A fires on an EXACT LINK match only — normalised scheme, `www.` and a
 * trailing slash, nothing else. Never on the briefing's text match: on
 * `de188d66` (11-02) the text match named a different fair (OPE-1571), and
 * reply A would have told a Vassalboro organizer their market is the Waterville
 * fair. No domain matching either: facebook.com alone maps to 19 series.
 *
 * ⚠️ The match never writes to the matched event (ticket note). It only picks
 * the reply.
 */
import { and, asc, desc, gte, inArray, isNull } from "drizzle-orm";
import { formatDateMedium } from "@takemetothefair/datetime";
import { events } from "../schema.js";
import type { Db } from "../db.js";
import { publicEventWhere } from "../helpers.js";
import { isShareRedirectHost } from "./share-redirect.js";
import type { ReplyParams } from "./types.js";

/**
 * What happened to the link, as the producing branch observed it.
 *
 * `undefined` (not set) means the branch never fetched it — the GH #244
 * free-text override routes a body with prose past a signature/footer link.
 * Neither B ("we opened the page") nor C ("we couldn't open it") is true
 * there, so that case keeps the pre-ruling copy rather than claiming either.
 */
export type LinkOutcome = "fetched-no-event" | "fetch-failed";

/**
 * Every spelling of `url` that the ruling counts as the same link: http/https
 * × with/without `www.` × with/without a trailing slash. Path, query and case
 * of the path are kept as sent — "exact" means exact apart from those three.
 *
 * Returns [] for anything that is not an http(s) URL.
 */
export function exactLinkVariants(url: string | null | undefined): string[] {
  if (typeof url !== "string" || url.trim() === "") return [];
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return [];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  const bareHost = u.host.toLowerCase().replace(/^www\./, "");
  // The fragment is never part of what a server sees, so it is not part of the link.
  const rest = `${u.pathname}${u.search}`;
  const withoutSlash = u.search ? rest : rest.endsWith("/") ? rest.replace(/\/+$/, "") : rest;
  const tails = new Set<string>();
  if (u.search) {
    tails.add(rest);
  } else {
    tails.add(withoutSlash);
    tails.add(`${withoutSlash}/`);
  }
  const out = new Set<string>();
  for (const scheme of ["https://", "http://"]) {
    for (const host of [bareHost, `www.${bareHost}`]) {
      for (const tail of tails) out.add(`${scheme}${host}${tail}`);
    }
  }
  return [...out];
}

export interface ListedEvent {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * The public event whose stored `source_url` is this exact link, or null.
 *
 * Public only (`publicEventWhere`) and never a merge tombstone: reply A hands
 * the sender our URL, so it must be a page that is live. When several editions
 * share one home page (a series site), the next upcoming one wins, else the
 * most recent past one.
 */
export async function findListedEventByExactLink(
  db: Db,
  url: string | null | undefined,
  now: Date = new Date()
): Promise<ListedEvent | null> {
  const variants = exactLinkVariants(url);
  if (variants.length === 0) return null;
  const base = and(
    inArray(events.sourceUrl, variants),
    isNull(events.mergedInto),
    publicEventWhere()
  );
  const cols = {
    id: events.id,
    slug: events.slug,
    name: events.name,
    startDate: events.startDate,
    endDate: events.endDate,
  };
  const [upcoming] = await db
    .select(cols)
    .from(events)
    .where(and(base, gte(events.endDate, now)))
    .orderBy(asc(events.startDate))
    .limit(1);
  if (upcoming) return upcoming as ListedEvent;
  const [recent] = await db
    .select(cols)
    .from(events)
    .where(base)
    .orderBy(desc(events.startDate))
    .limit(1);
  return (recent as ListedEvent | undefined) ?? null;
}

/** "Oct 2, 2026", or "Oct 2, 2026 – Oct 3, 2026" when the days differ. */
export function listedEventDates(ev: Pick<ListedEvent, "startDate" | "endDate">): string {
  const s = ev.startDate ? formatDateMedium(ev.startDate) : "";
  const e = ev.endDate ? formatDateMedium(ev.endDate) : "";
  if (!s) return e;
  if (!e || e === s) return s;
  return `${s} – ${e}`;
}

/**
 * Reply C's cause sentence. The shortener line only when one was detected —
 * the ruling: "Do not list sender-side causes unless one actually applies".
 */
export function linkCauseSentence(url: string | null | undefined): string {
  return typeof url === "string" && isShareRedirectHost(url)
    ? "It looks like a shortened or redirect link, and those don't always open for us."
    : "The site didn't let our reader in.";
}

export interface LinkReplyDecision {
  kind: "already-listed-link" | "unfetchable-url";
  params: ReplyParams;
  /** B promises a person will look, so B must put the row in the review queue. */
  flagForReview: boolean;
}

/**
 * Pure: given the link, what the branch observed, and the exact-link match (if
 * any), pick the reply. The DB read is `findListedEventByExactLink`, kept
 * separate so this is testable without one.
 */
export function decideLinkReply(input: {
  link: string | null | undefined;
  linkOutcome: LinkOutcome | null | undefined;
  listed: ListedEvent | null;
  params: ReplyParams;
}): LinkReplyDecision {
  const { link, linkOutcome, listed, params } = input;
  if (listed) {
    return {
      kind: "already-listed-link",
      params: {
        ...params,
        listedEventId: listed.id,
        listedEventName: listed.name,
        listedEventDates: listedEventDates(listed),
        listedEventUrl: `https://meetmeatthefair.com/events/${listed.slug}`,
      },
      flagForReview: false,
    };
  }
  const withLink = link ? { ...params, attemptedUrl: params.attemptedUrl ?? link } : params;
  if (linkOutcome === "fetched-no-event") {
    return {
      kind: "unfetchable-url",
      params: { ...withLink, linkOutcome },
      flagForReview: true,
    };
  }
  if (linkOutcome === "fetch-failed") {
    return {
      kind: "unfetchable-url",
      params: { ...withLink, linkOutcome, causeSentence: linkCauseSentence(link) },
      flagForReview: false,
    };
  }
  return { kind: "unfetchable-url", params: withLink, flagForReview: false };
}
