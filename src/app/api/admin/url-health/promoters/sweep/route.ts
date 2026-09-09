export const dynamic = "force-dynamic";
/**
 * OPE-868 — re-read every promoter's own website, and record what we saw.
 *
 * ## Why this exists as its own sweep
 *
 * `promoters.website` is fetched by NOTHING. The event-date-drift sweep selects
 * it (`sweep/route.ts`) and uses it for exactly one thing — a `sameHost()`
 * string comparison — then fetches `events.source_url` and nothing else. So the
 * field is read out of the database, compared as text, and never resolved over
 * the network by any rail in either Worker.
 *
 * That is where the failing specimen actually lived. OPE-824 cleared the dead
 * `ledyardfair.org` from the EVENT's `source_url` on 2026-09-06; three days
 * later it was still in `promoters.website`, rendering as that promoter's
 * official website, until an analyst nulled it by hand. OPE-860's fix — which
 * rides the drift sweep — would not have caught it either.
 *
 * It is not bolted onto the drift sweep because that sweep is budgeted against
 * a 5-minute step timeout already tuned down from a Worker→Pages 524, and its
 * contract is date drift, not link health. A second URL per row changes a
 * budget somebody measured.
 *
 * ## Sizing, measured rather than assumed (OPE-868 scope 5)
 *
 * Prod, 2026-09-09: **750 promoters, 615 with a website, 612 DISTINCT websites.**
 * At `chunk=50` that is 13 chunks for full coverage.
 *
 * ⚠️ The 50 is NOT copied from the drift sweep by analogy — that is the mistake
 * `[[feedback_a_threshold_chosen_by_analogy_is_unverified]]` warns about. It is
 * reused because the drift sweep MEASURED it for the identical operation: one
 * HTTP fetch per URL with the same per-URL timeout, "50 × per-URL fetch ≈ 30-45s,
 * comfortably under" the ~100s edge budget. Same work, same measured bound. What
 * would have been analogy is reusing its *window* or its *cadence*, and neither
 * is reused here.
 *
 * ## ⚠️ This never writes to the promoter
 *
 * A `no_event_signal` verdict is evidence for an operator, not an instruction.
 * A real organizer site that renders its dates in an image reads
 * `no_event_signal` too — the asymmetry is deliberate and documented in
 * url-health.ts. Nothing here nulls a website or unpublishes anything.
 */
import { NextResponse } from "next/server";
import { and, isNotNull, ne, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, urlHealthChecks } from "@/lib/db/schema";
import { classifyUrlHealth, isActionable } from "@/lib/goodwill/url-health";
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";
import { logError } from "@/lib/logger";

const DEFAULT_CHUNK = 50;
const MAX_CHUNK = 100;
const FETCH_TIMEOUT_MS = 10_000;

/** The field name recorded on every row this sweep writes. */
export const SOURCE_FIELD = "promoters.website";

interface Probe {
  reachedOrigin: boolean;
  status: number | null;
  html: string | null;
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
    // Only read a body on a 2xx — a 404 page's prose is not evidence about the
    // organizer, and reading it would let a themed error page score as healthy.
    const html = res.ok ? await res.text() : null;
    return { reachedOrigin: true, status: res.status, html };
  } catch {
    return { reachedOrigin: false, status: null, html: null };
  } finally {
    clearTimeout(timer);
  }
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

  try {
    // One row per DISTINCT website. 615 promoters share 612 URLs today, so the
    // dedup saves little — but it is the right unit regardless: fetching the
    // same page twice because two promoters point at it would double the cost
    // and write two rows asserting one fact.
    const rows = await db
      .selectDistinct({ website: promoters.website })
      .from(promoters)
      .where(and(isNotNull(promoters.website), ne(promoters.website, "")))
      .orderBy(promoters.website)
      .limit(chunk)
      .offset(cursor);

    const result = {
      success: true,
      cursor,
      chunk,
      /**
       * ⚠️ The positive landmark, and the reason it is in the RESPONSE rather
       * than only in a log: a sweep whose selector silently stops matching
       * reports zero flagged and reads as a clean bill of health. `examined`
       * going to 0 while `next_cursor` is still non-null is the tell.
       */
      examined: rows.length,
      ok: 0,
      no_event_signal: 0,
      http_error: 0,
      unreachable: 0,
      actionable: 0,
      next_cursor: null as number | null,
    };

    for (const r of rows) {
      const website = (r.website ?? "").trim();
      if (!website) continue;
      const p = await probe(website);
      const health = classifyUrlHealth(p);

      await db.insert(urlHealthChecks).values({
        url: website,
        sourceField: SOURCE_FIELD,
        verdict: health.verdict,
        httpStatus: p.status,
        signals: health.signals.join(",") || null,
        detail: health.detail,
        checkedAt: now,
      });

      result[health.verdict] += 1;
      if (isActionable(health.verdict)) result.actionable += 1;
    }

    result.next_cursor = rows.length === chunk ? cursor + chunk : null;
    return NextResponse.json(result);
  } catch (error) {
    await logError(db, {
      message: "promoter url-health sweep threw",
      error,
      source: "api/admin/url-health/promoters/sweep",
      request,
    });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

/**
 * GET — the operator-readable half (OPE-868 scope 4).
 *
 * OPE-860 shipped `url_health_checks` with no consumer beyond a counter, which
 * is a table nobody looks at. This is the reader.
 *
 * Reports the LATEST verdict per URL, not every row: the table is append-only
 * so that a repeated `no_event_signal` can be told from a one-off blip, and a
 * reader that dumped all history would bury the current state in it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getCloudflareDb();
  try {
    const latest = await db.all<{
      url: string;
      source_field: string;
      verdict: string;
      detail: string | null;
      checked_at: number;
      consecutive: number;
    }>(sql`
      WITH ranked AS (
        SELECT url, source_field, verdict, detail, checked_at,
               -- rowid is the tiebreak, and it is load-bearing: checked_at is
               -- unix SECONDS, so two checks of one URL inside a single second
               -- rank arbitrarily without it and "latest verdict" silently
               -- returns the OLDER row. The sweep runs daily in production so
               -- this would never have surfaced there; a test that swept twice
               -- in a row is what caught it. rowid is monotonic per insert.
               ROW_NUMBER() OVER (PARTITION BY url ORDER BY checked_at DESC, rowid DESC) AS rn
        FROM url_health_checks
      )
      SELECT r.url, r.source_field, r.verdict, r.detail, r.checked_at,
             (SELECT COUNT(*) FROM url_health_checks h
               WHERE h.url = r.url AND h.verdict = r.verdict) AS consecutive
      FROM ranked r
      WHERE r.rn = 1 AND r.verdict IN ('no_event_signal', 'http_error')
      ORDER BY r.checked_at DESC
      LIMIT 200
    `);

    // Landmark again: "0 actionable" is only meaningful beside "N URLs have
    // ever been checked". Without it, an empty table and a healthy estate are
    // the same answer — the exact ambiguity OPE-860 was filed about.
    const [totals] = await db.all<{ urls_checked: number; rows: number }>(sql`
      SELECT COUNT(DISTINCT url) AS urls_checked, COUNT(*) AS rows
      FROM url_health_checks
    `);

    return NextResponse.json({
      success: true,
      urls_ever_checked: totals?.urls_checked ?? 0,
      total_observations: totals?.rows ?? 0,
      actionable_count: latest.length,
      actionable: latest,
      note:
        "Advisory only. A real organizer site that renders its dates in an image " +
        "also reads no_event_signal. Never null a website or unpublish on this alone.",
    });
  } catch (error) {
    await logError(db, {
      message: "url-health report threw",
      error,
      source: "api/admin/url-health/promoters/sweep",
      request,
    });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
}
