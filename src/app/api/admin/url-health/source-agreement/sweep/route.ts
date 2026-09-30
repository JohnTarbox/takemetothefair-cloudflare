export const dynamic = "force-dynamic";
/**
 * OPE-988 — re-read each organizer page an event cites, and ask two questions
 * nothing else asks: is it about THIS event's town (source-agreement.ts), and is
 * the domain still the organizer's at all (domain-takeover.ts)?
 *
 * ## Why its own sweep, not the drift sweep
 *
 * The drift sweep fetches `events.source_url` already, but its candidate set is
 * FUTURE-only (a 30–90 day window plus promoter-owned domains), it is budgeted
 * against a measured step timeout, and it is being extended concurrently. The
 * specimen event (Leominster, 19 Sep) is inside this window and inside that one,
 * but "recent" events — the week after, when a wrong URL is still published on
 * a page people share — are not in the drift set at all. Same per-URL work, so
 * the same MEASURED chunk bound (50 URLs × one fetch ≈ 30–45 s, under the ~100 s
 * edge budget; see promoters/sweep/route.ts) applies.
 *
 * ## What it writes
 *
 * - One `url_health_checks` row per distinct URL per look, for EVERY verdict,
 *   under `source_field = 'events.source_url@source-agreement'`. The distinct
 *   field is load-bearing: the drift sweep writes `events.source_url` rows to the
 *   same table, and the heartbeat probe for THIS path must not be held green by
 *   that writer (the OPE-865 / OPE-868 lesson).
 * - Nothing to `event_discrepancies`. Disagreements come back in the response
 *   and the MCP workflow files them through `captureDiscrepancy`, the one
 *   idempotent writer of that table (open-row dedup on event × field × detector).
 *
 * ## ⚠️ Never writes to the event
 *
 * A disagreement is evidence for an operator. `source_url` is never nulled here.
 */
import { NextResponse } from "next/server";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, promoters, urlHealthChecks, venues } from "@/lib/db/schema";
import { classifyUrlHealth, isActionable } from "@/lib/goodwill/url-health";
import {
  checkSourceAgreement,
  isOrganizerSourceUrl,
  type SourceDisagreement,
} from "@/lib/goodwill/source-agreement";
import {
  detectDomainTakeover,
  isSweepActionable,
  type SweepVerdict,
} from "@/lib/goodwill/domain-takeover";
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";
import { logError } from "@/lib/logger";

const DEFAULT_CHUNK = 50;
const MAX_CHUNK = 100;
const FETCH_TIMEOUT_MS = 10_000;
/** "Recent": a wrong link keeps being shared for a while after the event. */
const LOOKBACK_DAYS = 30;
/** "Upcoming": far enough to catch a wrong link before the season it matters. */
const LOOKAHEAD_DAYS = 120;
const SOURCE_FIELD = "events.source_url@source-agreement";

interface Probe {
  reachedOrigin: boolean;
  status: number | null;
  html: string | null;
  finalUrl: string | null;
}

async function probe(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SCRAPER_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await res.text().catch(() => "");
    const html = (res.ok ? body : body.slice(0, 300_000)) || null;
    return { reachedOrigin: true, status: res.status, html, finalUrl: res.url || null };
  } catch {
    return { reachedOrigin: false, status: null, html: null, finalUrl: null };
  } finally {
    clearTimeout(timer);
  }
}

interface Candidate {
  url: string;
  events: Array<{
    id: string;
    slug: string;
    name: string;
    city: string | null;
    state: string | null;
    venueName: string | null;
    promoterName: string | null;
  }>;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
  const chunk = Math.min(
    MAX_CHUNK,
    Math.max(1, Number(url.searchParams.get("chunk") ?? 0) || DEFAULT_CHUNK)
  );

  const db = getCloudflareDb();
  const now = new Date();
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000);

  try {
    const rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        sourceUrl: events.sourceUrl,
        stateCode: events.stateCode,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
        promoterName: promoters.companyName,
      })
      .from(events)
      .leftJoin(venues, eq(venues.id, events.venueId))
      .leftJoin(promoters, eq(promoters.id, events.promoterId))
      .where(
        and(
          inArray(events.status, ["APPROVED", "TENTATIVE"]),
          isNull(events.mergedInto),
          isNotNull(events.sourceUrl),
          gte(events.startDate, from),
          lte(events.startDate, to)
        )
      )
      .orderBy(asc(events.startDate), asc(events.id));

    // One fetch per distinct URL; the organizer filter is applied BEFORE paging
    // so a cursor means the same thing on every call of one run.
    const byUrl = new Map<string, Candidate>();
    let skippedNonOrganizer = 0;
    for (const r of rows) {
      const u = (r.sourceUrl ?? "").trim();
      if (!u) continue;
      if (!isOrganizerSourceUrl(u)) {
        skippedNonOrganizer += 1;
        continue;
      }
      const c = byUrl.get(u) ?? { url: u, events: [] };
      c.events.push({
        id: r.id,
        slug: r.slug,
        name: r.name,
        city: r.venueCity ?? null,
        state: r.venueState ?? r.stateCode ?? null,
        venueName: r.venueName ?? null,
        promoterName: r.promoterName ?? null,
      });
      byUrl.set(u, c);
    }
    const all = [...byUrl.values()];
    const page = all.slice(cursor, cursor + chunk);

    const result = {
      success: true,
      cursor,
      chunk,
      /**
       * The denominator, in the response on purpose: "0 disagreements" beside
       * "0 examined" is a dead selector, not a clean estate.
       */
      events_in_window: rows.length,
      skipped_non_organizer_events: skippedNonOrganizer,
      organizer_urls_total: all.length,
      examined: page.length,
      /**
       * Count per verdict, keyed by whatever verdict was recorded — an open map
       * rather than fixed fields, so a verdict added to url-health.ts later is
       * counted instead of breaking the type.
       */
      verdicts: {} as Record<string, number>,
      domain_takeover: 0,
      actionable: 0,
      agreement: { agrees: 0, disagrees: 0, unjudged: 0 },
      disagreements: [] as SourceDisagreement[],
      takeovers: [] as Array<{ url: string; finalUrl: string | null; signals: string[] }>,
      next_cursor: null as number | null,
    };

    for (const cand of page) {
      const p = await probe(cand.url);
      const base = classifyUrlHealth(p);
      const ok2xx = p.status !== null && p.status >= 200 && p.status < 300;
      const first = cand.events[0];

      const takeover = ok2xx
        ? detectDomainTakeover(p.html, {
            entityName: first.name,
            aliases: [...cand.events.map((e) => e.name), ...cand.events.map((e) => e.promoterName)],
            requestedUrl: cand.url,
            finalUrl: p.finalUrl,
          })
        : null;

      let verdict: SweepVerdict = base.verdict;
      const signals = [...base.signals];
      let detail = base.detail;
      if (takeover?.takenOver) {
        verdict = "domain_takeover";
        signals.push(...takeover.signals);
        detail = takeover.detail;
      }

      // Agreement only on a page that is plausibly the organizer's: a 2xx that
      // is not a takeover. A hijacked page "disagreeing" is the takeover's
      // finding, not a second one.
      if (ok2xx && !takeover?.takenOver) {
        const verdicts = cand.events.map((e) => ({
          e,
          a: checkSourceAgreement(p.html, {
            eventName: e.name,
            city: e.city,
            state: e.state,
            venueName: e.venueName,
          }),
        }));
        for (const { e, a } of verdicts) {
          if (a.agrees === true) result.agreement.agrees += 1;
          else if (a.agrees === false) {
            result.agreement.disagrees += 1;
            result.disagreements.push({
              eventId: e.id,
              slug: e.slug,
              sourceUrl: cand.url,
              city: e.city,
              state: e.state,
              venueName: e.venueName,
              otherStates: a.otherStates,
              signals: a.signals,
              detail: a.detail,
            });
          } else result.agreement.unjudged += 1;
        }
        const disagreeing = verdicts.filter((v) => v.a.agrees === false).length;
        signals.push(
          disagreeing > 0
            ? `agreement:disagrees(${disagreeing}/${verdicts.length})`
            : verdicts.some((v) => v.a.agrees === true)
              ? "agreement:agrees"
              : "agreement:unjudged"
        );
      }

      await db.insert(urlHealthChecks).values({
        url: cand.url,
        sourceField: SOURCE_FIELD,
        verdict,
        httpStatus: p.status,
        signals: signals.join(",") || null,
        detail: detail.slice(0, 500),
        checkedAt: now,
      });

      result.verdicts[verdict] = (result.verdicts[verdict] ?? 0) + 1;
      if (verdict === "domain_takeover") result.domain_takeover += 1;
      if (isSweepActionable(verdict, isActionable)) result.actionable += 1;
      if (verdict === "domain_takeover") {
        result.takeovers.push({ url: cand.url, finalUrl: p.finalUrl, signals: takeover!.signals });
        await logError(db, {
          level: "warn",
          message: `event source_url looks taken over: ${cand.url}`,
          source: "url-health:domain-takeover",
          context: {
            url: cand.url,
            finalUrl: p.finalUrl,
            events: cand.events.map((e) => e.slug),
            signals: takeover!.signals,
            detail: takeover!.detail,
          },
        });
      }
    }

    result.next_cursor = cursor + chunk < all.length ? cursor + chunk : null;
    return NextResponse.json(result);
  } catch (error) {
    await logError(db, {
      message: "source-agreement sweep threw",
      error,
      source: "api/admin/url-health/source-agreement/sweep",
      request,
    });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
