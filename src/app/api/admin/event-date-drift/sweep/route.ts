export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { classifySweepOutcome } from "@/lib/goodwill/sweep-outcome";
import {
  closestEvent,
  driftAgainstAll,
  groupCandidatesByUrl,
} from "@/lib/goodwill/drift-candidates";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventDateDriftFindings, events, promoters } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";
import { logError } from "@/lib/logger";

// Periodic re-verification sweep. Hits a slice of APPROVED upcoming events,
// re-fetches their source_url, compares the canonical date against the
// stored one, and records drift > 1 day in event_date_drift_findings.
//
// Triggered daily 6 AM UTC by the MCP worker's scheduled handler. Each call
// scans up to CHUNK_SIZE events; the scheduled handler can loop with
// ?cursor=N if more events qualify than fit in one budget.
//
// Auth: X-Internal-Key only (cron-driven, no user session).

const CHUNK_SIZE = 200;
const THROTTLE_MS = 500;
/** Host equality after stripping scheme, `www.` and port — OPE-814. */
function sameHost(a: string | null, b: string | null): boolean {
  const norm = (raw: string | null) => {
    if (!raw) return null;
    try {
      return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
        .toLowerCase()
        .replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  const ha = norm(a);
  const hb = norm(b);
  return ha != null && hb != null && ha === hb;
}

const FETCH_WINDOW_DAYS_MIN = 30;
const FETCH_WINDOW_DAYS_MAX = 90;
const DRIFT_THRESHOLD_DAYS = 1;
const FETCH_TIMEOUT_MS = 15_000;

interface SweepResult {
  scanned: number;
  drift_recorded: number;
  /**
   * OPE-815 — findings closed because the source now AGREES with us.
   *
   * Reported as its own number rather than folded into `drift_recorded`,
   * because "the organizer fixed their page" and "we found a new conflict" are
   * different events and a run that only does the former is not a quiet run.
   */
  drift_cleared: number;
  fetch_failed: number;
  next_cursor: number | null;
}

async function fetchCanonicalDate(
  url: string
): Promise<{ canonicalStartDate: Date | null; htmlExcerpt: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SCRAPER_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return { canonicalStartDate: null, htmlExcerpt: null };
    const html = await res.text();
    // Strip to JSON-LD blocks first — schema.org parser is reliable.
    const ldMatches = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
    if (ldMatches) {
      for (const block of ldMatches) {
        const json = block.replace(/<script[^>]*>|<\/script>/gi, "").trim();
        try {
          const parsed = parseJsonLd(JSON.parse(json));
          if (parsed.data?.startDate) {
            // schema.org startDate is ISO 8601; new Date handles both date-
            // only and full timestamp variants.
            const d = new Date(parsed.data.startDate);
            if (!isNaN(d.getTime())) {
              return { canonicalStartDate: d, htmlExcerpt: block.slice(0, 500) };
            }
          }
        } catch {
          // Malformed JSON-LD — keep trying other blocks
        }
      }
    }
    // Fallback: look for a visible date in OG metadata or microdata. Skip
    // for v1; if drift detection misses these the admin can still manually
    // verify the source. Future enhancement: og:event:start_time, microdata.
    return { canonicalStartDate: null, htmlExcerpt: null };
  } catch {
    return { canonicalStartDate: null, htmlExcerpt: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const cursor = Math.max(0, parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
  const chunk = Math.min(
    CHUNK_SIZE,
    Math.max(1, parseInt(url.searchParams.get("chunk") ?? String(CHUNK_SIZE), 10) || CHUNK_SIZE)
  );

  const db = getCloudflareDb();
  const now = new Date();
  const windowMin = new Date(now.getTime() + FETCH_WINDOW_DAYS_MIN * 86400 * 1000);
  const windowMax = new Date(now.getTime() + FETCH_WINDOW_DAYS_MAX * 86400 * 1000);

  let result: SweepResult;
  try {
    // ⚠️ OPE-814 — the candidate set, widened and de-duplicated.
    //
    // This was `status='APPROVED' AND start_date BETWEEN now+30d AND now+90d`,
    // which is why the radar has touched six domains ever: it fetched whatever
    // `source_url` happened to hang off events in a 60-day slice, and three
    // aggregators are the `source_url` on many events at once.
    //
    // Two changes, both from the query rather than from a list:
    //
    //   TENTATIVE is included. A tentative date is exactly the kind most worth
    //     checking against the organizer's own page.
    //   Promoter-own-domain events are included regardless of the forward
    //     window. That window is the `[[seasonal-markets-break-forward-gates]]`
    //     shape — a weekly market has most occurrences outside any 60-day slice
    //     at any moment, so the pages we most want to check were the ones it
    //     structurally could not reach.
    const rawCandidates = await db
      .select({
        eventId: events.id,
        startDate: events.startDate,
        sourceUrl: events.sourceUrl,
        promoterWebsite: promoters.website,
      })
      .from(events)
      .leftJoin(promoters, eq(promoters.id, events.promoterId))
      .where(
        and(
          inArray(events.status, ["APPROVED", "TENTATIVE"]),
          isNotNull(events.sourceUrl),
          gte(events.startDate, now),
          // Either inside the original forward window, OR on the promoter's own
          // domain at any future date.
          sql`(
            (${events.startDate} >= ${Math.floor(windowMin.getTime() / 1000)}
             AND ${events.startDate} <= ${Math.floor(windowMax.getTime() / 1000)})
            OR ${promoters.website} IS NOT NULL
          )`
        )
      )
      .orderBy(events.startDate);

    // One entry per distinct URL. The old loop fetched per EVENT, so a page
    // backing 36 events was fetched 36 times and filed 36 rows for one fact.
    const candidates = groupCandidatesByUrl(
      rawCandidates.map((r) => ({
        eventId: r.eventId,
        sourceUrl: r.sourceUrl,
        startDate: r.startDate,
        promoterOwned: sameHost(r.sourceUrl, r.promoterWebsite),
      }))
    ).slice(cursor, cursor + chunk);

    result = {
      scanned: candidates.length,
      drift_recorded: 0,
      drift_cleared: 0,
      fetch_failed: 0,
      next_cursor: null,
    };

    for (const cand of candidates) {
      // ONE fetch per URL, however many events sit behind it.
      const { canonicalStartDate, htmlExcerpt } = await fetchCanonicalDate(cand.sourceUrl);

      // ⚠️ OPE-814 — compare the page's date against the SET of dates we hold
      // for this URL, not against one representative event.
      //
      // Once the fetch is per-URL, "which of these 36 dates does the page
      // disagree with?" has no honest answer, and picking one manufactures the
      // exact defect OPE-815 scope 6 describes: four capecodchamber rows that
      // are one recurring series matched to different occurrences. A page
      // listing one occurrence of a weekly market AGREES with our data; scored
      // against an arbitrary sibling it would show a one-week drift forever.
      //
      // `driftAgainstAll` returns null when the page matches any date we hold.
      const smallestDrift = driftAgainstAll(canonicalStartDate, cand, DRIFT_THRESHOLD_DAYS);
      // The event the finding is filed against is the one the page is closest
      // to — the occurrence it most plausibly describes.
      const closest = closestEvent(canonicalStartDate, cand);
      const drift = smallestDrift ?? 0;
      const outcome = classifySweepOutcome(
        canonicalStartDate,
        smallestDrift === null ? 0 : smallestDrift,
        DRIFT_THRESHOLD_DAYS
      );
      if (outcome === "fetch-failed") {
        result.fetch_failed += 1;
      } else {
        if (outcome === "drift-recorded") {
          // UPSERT — UNIQUE (event_id, stored_start_date) makes re-runs
          // against the same (event, stored-date) pair idempotent.
          await db
            .insert(eventDateDriftFindings)
            .values({
              eventId: closest.id,
              storedStartDate: new Date(closest.startDate),
              canonicalStartDate,
              driftDays: drift,
              canonicalUrl: cand.sourceUrl,
              canonicalHtmlExcerpt: htmlExcerpt,
              checkedAt: now,
            })
            .onConflictDoUpdate({
              target: [eventDateDriftFindings.eventId, eventDateDriftFindings.storedStartDate],
              set: {
                canonicalStartDate,
                driftDays: drift,
                canonicalHtmlExcerpt: htmlExcerpt,
                checkedAt: now,
                // Don't clobber resolved_at — admin may have acknowledged
                // an earlier check and re-detection should reopen.
                resolvedAt: sql`NULL`,
              },
            });
          result.drift_recorded += 1;
        } else {
          // ⚠️ OPE-815 — the missing branch, and the whole of Defect 1.
          //
          // When the fetch SUCCEEDS and the source now agrees with us, this
          // block previously did nothing at all. The old unresolved finding
          // stayed unresolved, `stale-page-radar` lifted it again on the next
          // run, and `captureDiscrepancy` refreshed `last_seen_at` on the open
          // discrepancy — so a corrected page produced a row that read
          // "verified this morning".
          //
          // The ticket describes this as re-stamping "without re-reading the
          // page". The page WAS re-read. The agreement was discarded. That
          // distinction matters: a fix that only gated the timestamp on a real
          // fetch would not have closed the specimen row, because its fetch
          // succeeded.
          //
          // Specimen: `jenksproductions.com` recorded divergent 2025-11-15;
          // the page now reads "November 15, 2026", matching us exactly.
          const closed = await db
            .update(eventDateDriftFindings)
            .set({ resolvedAt: now, checkedAt: now })
            .where(
              and(
                eq(eventDateDriftFindings.eventId, closest.id),
                eq(eventDateDriftFindings.storedStartDate, new Date(closest.startDate)),
                isNull(eventDateDriftFindings.resolvedAt)
              )
            );
          result.drift_cleared += (closed as { meta?: { changes?: number } })?.meta?.changes ?? 0;
        }
      }
      // Throttle fetches to stay polite + fit Cloudflare's 30s per-request
      // budget. The schedule handler can loop via next_cursor if needed.
      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    }

    // If the chunk filled exactly, signal there may be more.
    if (candidates.length >= chunk) {
      result.next_cursor = cursor + chunk;
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    await logError(db, {
      message: "event-date-drift sweep failed",
      error,
      source: "api/admin/event-date-drift/sweep",
      request,
    });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
