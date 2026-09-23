/**
 * OPE-987 — re-read upcoming events' organizer pages for a cancellation notice.
 *
 * ## Why this exists
 *
 * `cape-cod-brew-fest` stayed SCHEDULED for ~39 days after its organizer page
 * said "2026 Festival Canceled". Nothing in either Worker re-reads an event's
 * own page for that: the drift sweep reads it for a DATE, the promoter sweep
 * reads `promoters.website` for LINK HEALTH (and the specimen's page is
 * perfectly healthy — it still renders the 2026 rosters).
 *
 * ## What it does
 *
 *   select   events APPROVED/TENTATIVE, not merged, lifecycle not already
 *            CANCELLED / OCCURRED / NO_SHOW, starting in the next WINDOW_DAYS,
 *            with a `source_url` that is NOT a third-party listing
 *   rotate   one fetch per DISTINCT url, skipping urls this pass already read
 *            in the last RECHECK_AFTER_HOURS, at most `limit` per call
 *   classify detectCancellationNotice (src/lib/goodwill/cancellation-notice.ts)
 *   record   one `url_health_checks` row per url read — the rotation state and
 *            the audit trail of what each read said, hit or not
 *   raise    on a hit, one `event_discrepancies` row per event on that url via
 *            captureDiscrepancy (field_class `status`, detected_by
 *            `stale_page_radar`), plus a warn in error_logs
 *   stamp    `agent_heartbeats` on EVERY completed call, so "nothing to check"
 *            and "not running" are different facts
 *
 * ## ⚠️ It never writes to the event
 *
 * A notice is evidence for an operator. Partial cancellations ("Saturday's
 * parade is cancelled") match too, and a wrong automatic CANCELLED would take a
 * live fair off the site. Nothing here touches `events`.
 *
 * ## Why `stale_page_radar` and not a new detector value
 *
 * That value already means "we re-read a source page and it no longer agrees
 * with our row", which is exactly this. The radar only ever files
 * `field_class='date'`, so the open-row dedup tuple (event_id, `status`,
 * `stale_page_radar`) belongs to this pass alone, and the health canary's
 * per-detector count and the MCP list/resolve tools already understand the
 * value — a new one would have to be threaded through each of them.
 */

import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notInArray } from "drizzle-orm";
import { chunkIds, classifySource, sourceCredibilityTier } from "@takemetothefair/utils";
import { fetchHtmlWithSsrfGuard } from "@takemetothefair/site-fetch";
import {
  detectCancellationNotice,
  type CancellationNoticeResult,
} from "../../../src/lib/goodwill/cancellation-notice.js";
import {
  agentHeartbeats,
  eventDataCitations,
  events,
  promoters,
  urlHealthChecks,
} from "../schema.js";
import type { Db } from "../db.js";
import { captureDiscrepancy, safeHost } from "./capture.js";
import { logError } from "../logger.js";

const SOURCE = "mcp:goodwill:cancellation-recheck";

/** `url_health_checks.source_field` for rows this pass writes. */
export const CANCELLATION_SOURCE_FIELD = "events.source_url:cancellation-notice";
/**
 * OPE-1099 — `url_health_checks.source_field` for an in-window event that has
 * NO organizer-owned page anywhere on its row, so this pass cannot check it.
 * `url` is the event's third-party source_url; `detail` names the slug. One row
 * per event per rotation window: "which live events could nobody check on day
 * D" becomes a query instead of a count buried in a heartbeat note.
 */
export const NO_ORGANIZER_PAGE_SOURCE_FIELD = "events:no-organizer-page";
/**
 * OPE-1099 — `url_health_checks.source_field` for the staleness read: after an
 * organizer page announces a cancellation, the event's third-party source_url
 * is read too, and the verdict records whether the listing had caught up.
 */
export const THIRD_PARTY_STALENESS_SOURCE_FIELD = "events.source_url:third-party-staleness";
/** `agent_heartbeats.agent_code` stamped on every completed call. */
export const CANCELLATION_HEARTBEAT_CODE = "watchdog:organizer-cancellation-recheck";

/** How far ahead an event is worth re-reading. A cancellation matters before the date. */
export const WINDOW_DAYS = 30;
/**
 * URLs per call. Sized to the workflow step, not by analogy: each fetch has a
 * FETCH_TIMEOUT_MS ceiling, so 20 × 10s = 200s worst case inside the step's
 * 5-minute timeout, with the per-step retry still fitting.
 */
export const DEFAULT_URLS_PER_CALL = 20;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * A url read within this many hours is skipped. Under 24h so a daily run that
 * starts a little earlier than yesterday's still re-reads everything.
 */
export const RECHECK_AFTER_HOURS = 20;

/**
 * Social and ticketing platforms. Neither existing classifier lists them —
 * `classifySource` knows DMO/aggregator hosts and `sourceCredibilityTier` knows
 * tier-2/3 listing sites — but they are third parties all the same: a Facebook
 * page is usually behind a login wall, and an Eventbrite/allevents listing is
 * exactly the kind of page that kept advertising the Brew Fest after the
 * organizer cancelled it. Measured in the 2026-09-13 candidate window: 3
 * facebook.com, 2 allevents.in, 1 events.humanitix.com.
 */
const PLATFORM_HOSTS = [
  "facebook.com",
  "fb.me",
  "instagram.com",
  "eventbrite.com",
  "allevents.in",
  "humanitix.com",
  "ticketmaster.com",
  "meetup.com",
  "patch.com",
];

/**
 * Why a source url is NOT the organizer's own page, or null when it may be.
 *
 * Reuses the two existing classifications first (OPE-987 asks that it not
 * invent a third): `classifySource(...).ingestionMethod === 'aggregator_import'`
 * and `sourceCredibilityTier(url) !== 1`.
 *
 * ⚠️ `classifySource` is called with the URL ONLY, never the stored
 * `source_name`. Its label map wins over its host check, so a
 * `fairsandfestivals.net` listing submitted with the label
 * `vendor-submission` classifies as `vendor_submission` — the label records
 * who SENT it, not whose page it is. Measured: that exact row
 * (`cornish-apple-festival`) got through with the label and raised a hit on
 * the aggregator's generic "some events do get cancelled" disclaimer.
 * `sourceName` stays in the signature for `source_name`-only hosts
 * ("aggregator-listing") and is consulted only when it says aggregator.
 */
export function thirdPartyReason(
  sourceUrl: string,
  sourceName: string | null | undefined
): string | null {
  const host = safeHost(sourceUrl);
  if (!host) return "unparseable-url";
  if (
    classifySource(null, sourceUrl).ingestionMethod === "aggregator_import" ||
    classifySource(sourceName, null).ingestionMethod === "aggregator_import"
  ) {
    return "aggregator";
  }
  if (sourceCredibilityTier(sourceUrl) !== 1) return "listing-tier";
  if (PLATFORM_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) return "platform";
  return null;
}

export interface RecheckEvent {
  id: string;
  slug: string;
  status: string;
  lifecycleStatus: string;
  startDate: Date;
  sourceUrl: string;
  sourceName: string | null;
  /** The organizer-owned page this pass reads for the event (OPE-1099). */
  checkUrl: string;
  /** Which row field `checkUrl` came from. `source_url` for every pre-OPE-1099 case. */
  via: OrganizerUrlVia;
}

/**
 * OPE-1099 — where an organizer-owned page can come from, in the order tried.
 *
 * `source_url` is where we FOUND the event, and for a third of the events this
 * pass skipped it was an aggregator or a DMO calendar — pages that kept
 * advertising `firefly-yoga-wellness-festival-2026` after its organizer
 * cancelled it. Before this, such an event was dropped from the recheck
 * entirely: not checked against the stale listing, not checked at all.
 *
 * The promoter's website is skipped for the `system-*` placeholder promoters,
 * whose website says nothing about any particular event.
 */
export type OrganizerUrlVia =
  | "source_url"
  | "promoter_website"
  | "citation"
  | "ticket_url"
  | "application_url";

export interface OrganizerUrlCandidates {
  sourceUrl: string;
  sourceName: string | null;
  promoterId: string | null;
  promoterWebsite: string | null;
  citationUrls: string[];
  ticketUrl: string | null;
  applicationUrl: string | null;
}

/** The first organizer-owned page on the row, or null when there is none. */
export function pickOrganizerUrl(
  c: OrganizerUrlCandidates
): { url: string; via: OrganizerUrlVia } | null {
  const ordered: Array<[string | null | undefined, OrganizerUrlVia, string | null]> = [
    [c.sourceUrl, "source_url", c.sourceName],
    [c.promoterId?.startsWith("system-") ? null : c.promoterWebsite, "promoter_website", null],
    ...c.citationUrls.map((u): [string, OrganizerUrlVia, null] => [u, "citation", null]),
    [c.ticketUrl, "ticket_url", null],
    [c.applicationUrl, "application_url", null],
  ];
  for (const [raw, via, name] of ordered) {
    const url = (raw ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (thirdPartyReason(url, name)) continue;
    return { url, via };
  }
  return null;
}

/** An in-window event this pass cannot check: nothing on its row is the organizer's. */
export interface UnverifiableEvent {
  id: string;
  slug: string;
  startDate: Date;
  sourceUrl: string;
  /** Why its source_url was not usable — aggregator / listing-tier / platform. */
  reason: string;
}

export interface RecheckSelection {
  /** Events in the window with a source url, before any exclusion. */
  inWindow: number;
  /** Of those, whose source_url is a third-party listing. */
  excludedThirdParty: number;
  /** Of the third-party ones, read instead via another organizer-owned url (OPE-1099). */
  rescuedViaAlternate: number;
  /** Of the third-party ones, with NO organizer-owned url anywhere — named, not just counted. */
  unverifiable: UnverifiableEvent[];
  /** Distinct organizer urls after exclusion. */
  distinctUrls: number;
  /** Distinct urls skipped because this pass read them recently. */
  recentlyChecked: number;
  /** The urls to read now, each with every event that points at it. */
  batch: Array<{ url: string; events: RecheckEvent[] }>;
  /** Due urls left over after `limit` — the workflow loops until this is 0. */
  remaining: number;
}

export async function selectCancellationRecheck(
  db: Db,
  now: Date,
  limit: number
): Promise<RecheckSelection> {
  const until = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      status: events.status,
      lifecycleStatus: events.lifecycleStatus,
      startDate: events.startDate,
      sourceUrl: events.sourceUrl,
      sourceName: events.sourceName,
      ticketUrl: events.ticketUrl,
      applicationUrl: events.applicationUrl,
      promoterId: events.promoterId,
      promoterWebsite: promoters.website,
    })
    .from(events)
    .leftJoin(promoters, eq(promoters.id, events.promoterId))
    .where(
      and(
        inArray(events.status, ["APPROVED", "TENTATIVE"]),
        isNull(events.mergedInto),
        // NO_SHOW is terminal as well; POSTPONED stays in scope on purpose — a
        // postponement that becomes a cancellation is still news.
        notInArray(events.lifecycleStatus, ["CANCELLED", "OCCURRED", "NO_SHOW"]),
        gte(events.startDate, now),
        lt(events.startDate, until),
        isNotNull(events.sourceUrl),
        ne(events.sourceUrl, "")
      )
    )
    .orderBy(events.startDate)
    // Safety cap only: the 30-day window held 196 such rows on 2026-09-13.
    .limit(2000);

  // OPE-1099 — active citation urls, fetched only for the events whose own
  // source_url is third-party (the only ones that need an alternative), and
  // chunked: an inArray fed by a previous query's rows must stay under D1's
  // 100-bound-parameter cap however busy the window is.
  const needAlternate = rows.filter(
    (r) => r.sourceUrl && r.startDate && thirdPartyReason(r.sourceUrl.trim(), r.sourceName)
  );
  const citationsByEvent = new Map<string, string[]>();
  for (const ids of chunkIds(needAlternate.map((r) => r.id))) {
    const cites = await db
      .selectDistinct({ eventId: eventDataCitations.eventId, url: eventDataCitations.sourceUrl })
      .from(eventDataCitations)
      .where(
        and(
          inArray(eventDataCitations.eventId, ids),
          eq(eventDataCitations.state, "active"),
          isNotNull(eventDataCitations.sourceUrl)
        )
      );
    for (const c of cites) {
      if (!c.url) continue;
      citationsByEvent.set(c.eventId, [...(citationsByEvent.get(c.eventId) ?? []), c.url]);
    }
  }

  const byUrl = new Map<string, RecheckEvent[]>();
  let excludedThirdParty = 0;
  let rescuedViaAlternate = 0;
  const unverifiable: UnverifiableEvent[] = [];
  for (const r of rows) {
    const url = (r.sourceUrl ?? "").trim();
    if (!url || !r.startDate) continue;
    const why = thirdPartyReason(url, r.sourceName);
    if (why) excludedThirdParty++;
    const pick = pickOrganizerUrl({
      sourceUrl: url,
      sourceName: r.sourceName,
      promoterId: r.promoterId,
      promoterWebsite: r.promoterWebsite,
      citationUrls: citationsByEvent.get(r.id) ?? [],
      ticketUrl: r.ticketUrl,
      applicationUrl: r.applicationUrl,
    });
    if (!pick) {
      unverifiable.push({
        id: r.id,
        slug: r.slug,
        startDate: r.startDate,
        sourceUrl: url,
        reason: why ?? "unknown",
      });
      continue;
    }
    if (why) rescuedViaAlternate++;
    const ev: RecheckEvent = {
      id: r.id,
      slug: r.slug,
      status: r.status,
      lifecycleStatus: r.lifecycleStatus,
      startDate: r.startDate,
      sourceUrl: url,
      sourceName: r.sourceName,
      checkUrl: pick.url,
      via: pick.via,
    };
    const list = byUrl.get(pick.url);
    if (list) list.push(ev);
    else byUrl.set(pick.url, [ev]);
  }

  // Rotation state: urls this pass read recently. One small indexed read
  // rather than an inArray over candidate urls, which would bind one param per
  // url and cross D1's 100-parameter cap on a busy fortnight.
  const recent = await db
    .selectDistinct({ url: urlHealthChecks.url })
    .from(urlHealthChecks)
    .where(
      and(
        eq(urlHealthChecks.sourceField, CANCELLATION_SOURCE_FIELD),
        gt(urlHealthChecks.checkedAt, new Date(now.getTime() - RECHECK_AFTER_HOURS * 3_600_000))
      )
    );
  const recentSet = new Set(recent.map((r) => r.url));

  const due = [...byUrl.entries()].filter(([url]) => !recentSet.has(url));
  const batch = due.slice(0, limit).map(([url, evs]) => ({ url, events: evs }));
  return {
    inWindow: rows.length,
    excludedThirdParty,
    rescuedViaAlternate,
    unverifiable,
    distinctUrls: byUrl.size,
    recentlyChecked: byUrl.size - due.length,
    batch,
    remaining: due.length - batch.length,
  };
}

export interface FetchedPage {
  ok: boolean;
  status: number | null;
  html: string | null;
  error?: string;
}

export type PageFetcher = (url: string) => Promise<FetchedPage>;

/** SSRF-guarded fetch with a hard timeout — the helper the registration screen uses. */
export const defaultPageFetcher: PageFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const out = await fetchHtmlWithSsrfGuard(url, controller.signal);
    return out.ok
      ? { ok: true, status: 200, html: out.html }
      : { ok: false, status: out.status, html: null, error: out.error };
  } catch (err) {
    return { ok: false, status: null, html: null, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
};

export interface CancellationRecheckResult {
  inWindow: number;
  excludedThirdParty: number;
  /** OPE-1099 — third-party-sourced events read via another organizer-owned url. */
  rescuedViaAlternate: number;
  /** OPE-1099 — in-window events with no organizer-owned url at all, by slug. */
  unverifiable: string[];
  /** OPE-1099 — of those, newly recorded this call (rotation-limited like the reads). */
  unverifiableRecorded: number;
  /** OPE-1099 — after an organizer hit: third-party listings still advertising the event. */
  thirdPartyStillLive: number;
  /** OPE-1099 — after an organizer hit: third-party listings that had caught up. */
  thirdPartyCaughtUp: number;
  distinctUrls: number;
  recentlyChecked: number;
  examined: number;
  fetchFailed: number;
  notices: number;
  discrepanciesOpened: number;
  /** Hit on an event that already had an open row — last_seen_at refreshed. */
  discrepanciesAlreadyOpen: number;
  remaining: number;
  hits: Array<{ url: string; slugs: string[]; phrase: string; scope: string; scopes: string[] }>;
}

/** Confidence that the page announces this event is off. */
function confidenceFor(scope: string): number {
  if (scope === "year") return 0.8;
  if (scope === "series") return 0.7;
  return 0.6;
}

function describe(result: CancellationNoticeResult): string {
  return result.hits
    .slice(0, 4)
    .map((h) => `[${h.region}/${h.scope}] "${h.sentence}"`)
    .join(" | ");
}

export async function runCancellationRecheck(
  db: Db,
  opts: { now?: Date; limit?: number; fetchPage?: PageFetcher } = {}
): Promise<CancellationRecheckResult> {
  const now = opts.now ?? new Date();
  const fetchPage = opts.fetchPage ?? defaultPageFetcher;
  const sel = await selectCancellationRecheck(db, now, opts.limit ?? DEFAULT_URLS_PER_CALL);

  const result: CancellationRecheckResult = {
    inWindow: sel.inWindow,
    excludedThirdParty: sel.excludedThirdParty,
    rescuedViaAlternate: sel.rescuedViaAlternate,
    unverifiable: sel.unverifiable.map((u) => u.slug),
    unverifiableRecorded: 0,
    thirdPartyStillLive: 0,
    thirdPartyCaughtUp: 0,
    distinctUrls: sel.distinctUrls,
    recentlyChecked: sel.recentlyChecked,
    examined: 0,
    fetchFailed: 0,
    notices: 0,
    discrepanciesOpened: 0,
    discrepanciesAlreadyOpen: 0,
    remaining: sel.remaining,
    hits: [],
  };

  // OPE-1099 — name the events nobody can check. Rotation-limited the same way
  // the reads are, so a workflow that calls this several times a day writes one
  // row per event per window rather than one per call.
  if (sel.unverifiable.length > 0) {
    const since = new Date(now.getTime() - RECHECK_AFTER_HOURS * 3_600_000);
    const already = await db
      .selectDistinct({ url: urlHealthChecks.url })
      .from(urlHealthChecks)
      .where(
        and(
          eq(urlHealthChecks.sourceField, NO_ORGANIZER_PAGE_SOURCE_FIELD),
          gt(urlHealthChecks.checkedAt, since)
        )
      );
    const seen = new Set(already.map((r) => r.url));
    for (const u of sel.unverifiable) {
      if (seen.has(u.sourceUrl)) continue;
      seen.add(u.sourceUrl);
      await db.insert(urlHealthChecks).values({
        url: u.sourceUrl,
        sourceField: NO_ORGANIZER_PAGE_SOURCE_FIELD,
        verdict: "no_organizer_page",
        httpStatus: null,
        signals: `reason:${u.reason}`,
        detail: `${u.slug} (${u.startDate.toISOString().slice(0, 10)}) — only source is third-party; nothing on the row is the organizer's own page, so a cancellation cannot be detected`,
        checkedAt: now,
      });
      result.unverifiableRecorded++;
    }
  }

  for (const { url, events: evs } of sel.batch) {
    result.examined++;
    const page = await fetchPage(url);
    if (!page.ok || !page.html) {
      result.fetchFailed++;
      await db.insert(urlHealthChecks).values({
        url,
        sourceField: CANCELLATION_SOURCE_FIELD,
        verdict: "fetch_failed",
        httpStatus: page.status,
        signals: null,
        detail: (page.error ?? "no body").slice(0, 300),
        checkedAt: now,
      });
      continue;
    }

    // Classified per edition year: a url shared by events in two years (a
    // December/January window) must not let one year's history hide the other's.
    const byYear = new Map<number, RecheckEvent[]>();
    for (const ev of evs) {
      const y = ev.startDate.getUTCFullYear();
      byYear.set(y, [...(byYear.get(y) ?? []), ev]);
    }

    let anyHit = false;
    const signals = new Set<string>();
    const details: string[] = [];
    for (const [year, yearEvents] of byYear) {
      const notice = detectCancellationNotice(page.html, { eventYear: year });
      if (!notice.matched || !notice.scope || !notice.phrase) continue;
      anyHit = true;
      notice.scopes.forEach((s) => signals.add(`scope:${s}`));
      details.push(`${year}: ${describe(notice)}`);
      result.hits.push({
        url,
        slugs: yearEvents.map((e) => e.slug),
        phrase: notice.phrase,
        scope: notice.scope,
        scopes: notice.scopes,
      });

      for (const ev of yearEvents) {
        const id = await captureDiscrepancy(db, {
          eventId: ev.id,
          fieldClass: "status",
          detectedBy: "stale_page_radar",
          authoritativeValue: `lifecycle_status=${ev.lifecycleStatus}`,
          authoritativeSourceKey: safeHost(ev.sourceUrl),
          divergentValue: `CANCELLED (scope: ${notice.scope}) — '${notice.phrase}'`,
          divergentSourceKey: safeHost(url),
          divergentSourceUrl: url,
          confidence: confidenceFor(notice.scope),
          // The organizer published this; there is nothing to ask them. What a
          // promoter email may say about a cancellation is not this pass's call.
          forceOutreachCandidate: false,
          notes:
            `OPE-987 organizer-page cancellation notice (scopes: ${notice.scopes.join(", ")}) ${describe(notice)}`.slice(
              0,
              1000
            ),
        });
        if (id) result.discrepanciesOpened++;
        else result.discrepanciesAlreadyOpen++;

        // OPE-1099 — the organizer said no; did the listing we FOUND the event
        // on ever hear? Measured, not assumed: on the specimen all three
        // aggregators were still advertising it. Only when the source is a
        // third party and is not the page we just read.
        if (ev.sourceUrl !== url && thirdPartyReason(ev.sourceUrl, ev.sourceName)) {
          const listing = await fetchPage(ev.sourceUrl);
          const caughtUp =
            listing.ok && listing.html
              ? detectCancellationNotice(listing.html, { eventYear: year }).matched
              : null;
          if (caughtUp === true) result.thirdPartyCaughtUp++;
          if (caughtUp === false) result.thirdPartyStillLive++;
          await db.insert(urlHealthChecks).values({
            url: ev.sourceUrl,
            sourceField: THIRD_PARTY_STALENESS_SOURCE_FIELD,
            verdict:
              caughtUp === null
                ? "fetch_failed"
                : caughtUp
                  ? "third_party_reports_cancellation"
                  : "third_party_still_live",
            httpStatus: listing.status,
            signals: `organizer:${safeHost(url) ?? url}`,
            detail: `${ev.slug}: organizer page ${url} announces a cancellation`.slice(0, 300),
            checkedAt: now,
          });
        }
      }
    }

    await db.insert(urlHealthChecks).values({
      url,
      sourceField: CANCELLATION_SOURCE_FIELD,
      verdict: anyHit ? "cancellation_notice" : "no_cancellation_notice",
      httpStatus: page.status,
      signals: [...signals].join(",") || null,
      detail: anyHit ? details.join(" || ").slice(0, 1000) : null,
      checkedAt: now,
    });

    if (anyHit) {
      result.notices++;
      await logError(db, {
        level: "warn",
        source: SOURCE,
        message: `organizer page announces cancellation: ${url}`,
        context: {
          url,
          slugs: evs.map((e) => e.slug),
          detail: details.join(" || ").slice(0, 1000),
        },
      });
    }
  }

  // The run stamp — written whenever the pass completes, INCLUDING when it had
  // nothing to read. A probe on discrepancies would sit silent through every
  // week in which no organizer cancels, which is nearly every week; that is
  // the OPE-541 false-fire. A pass that THROWS before here writes no stamp, so
  // a broken selector goes red rather than green.
  const note =
    `inWindow=${result.inWindow} thirdParty=${result.excludedThirdParty} ` +
    `rescued=${result.rescuedViaAlternate} unverifiable=${result.unverifiable.length} urls=${result.distinctUrls} ` +
    `recent=${result.recentlyChecked} examined=${result.examined} fetchFailed=${result.fetchFailed} ` +
    `notices=${result.notices} opened=${result.discrepanciesOpened} remaining=${result.remaining}`;
  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: CANCELLATION_HEARTBEAT_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    await logError(db, { source: SOURCE, message: "run-stamp write failed", error });
  }

  return result;
}
