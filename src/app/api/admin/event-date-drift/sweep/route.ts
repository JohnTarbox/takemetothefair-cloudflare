export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventDateDriftFindings } from "@/lib/db/schema";
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
const FETCH_WINDOW_DAYS_MIN = 30;
const FETCH_WINDOW_DAYS_MAX = 90;
const DRIFT_THRESHOLD_DAYS = 1;
const FETCH_TIMEOUT_MS = 15_000;

interface SweepResult {
  scanned: number;
  drift_recorded: number;
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

function daysBetween(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
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
    const candidates = await db
      .select({
        id: events.id,
        startDate: events.startDate,
        sourceUrl: events.sourceUrl,
      })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          isNotNull(events.sourceUrl),
          gte(events.startDate, windowMin),
          lte(events.startDate, windowMax)
        )
      )
      .orderBy(events.startDate)
      .limit(chunk)
      .offset(cursor);

    result = { scanned: candidates.length, drift_recorded: 0, fetch_failed: 0, next_cursor: null };

    for (const ev of candidates) {
      if (!ev.startDate || !ev.sourceUrl) continue;
      const { canonicalStartDate, htmlExcerpt } = await fetchCanonicalDate(ev.sourceUrl);
      if (!canonicalStartDate) {
        result.fetch_failed += 1;
      } else {
        const drift = daysBetween(ev.startDate, canonicalStartDate);
        if (drift > DRIFT_THRESHOLD_DAYS) {
          // UPSERT — UNIQUE (event_id, stored_start_date) makes re-runs
          // against the same (event, stored-date) pair idempotent.
          await db
            .insert(eventDateDriftFindings)
            .values({
              eventId: ev.id,
              storedStartDate: ev.startDate,
              canonicalStartDate,
              driftDays: drift,
              canonicalUrl: ev.sourceUrl,
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
