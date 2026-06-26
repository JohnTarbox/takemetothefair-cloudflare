/**
 * Rolling GSC URL Inspection sweep.
 *
 * GSC's URL Inspection API has a hard quota (~2000/day per property) and our
 * sitemap has ~2200 URLs. We can't sweep everything daily, so we rotate:
 *
 *   1. URLs that returned a non-OK verdict last sweep (re-check first)
 *   2. Recently published content (events APPROVED in last 24h, blog posts
 *      PUBLISHED in last 24h)
 *   3. Round-robin through the rest, ordered by last_inspected_at ASC
 *
 * Each non-OK verdict becomes a `health_issues` row via the shared
 * fingerprint helper in src/lib/site-health.ts so snoozes work the same way
 * as Bing-sourced issues.
 */

import { eq, and, gte, asc, desc, isNull, or, like, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  events,
  venues,
  promoters,
  blogPosts,
  gscInspectionState,
  healthIssues,
  eventSlugHistory,
  vendorSlugHistory,
  timeToIndexLog,
} from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { unsafeSlug } from "@takemetothefair/utils";
import { publicEventWhere } from "@/lib/event-lifecycle";
import { SITE_URL } from "@takemetothefair/constants";
import { inspectUrl, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { fingerprintFor } from "@/lib/site-health";
import { summarizeRichResults } from "@/lib/gsc-rich-results";
import { getIndexableVendorRows } from "@/lib/sitemap/indexable-vendors";

type Db = DrizzleD1Database<typeof schema>;

const DEFAULT_BATCH_SIZE = 200;
const HOST = SITE_URL;

function pathFromUrl(url: string): string {
  return url.replace(HOST, "") || "/";
}

/**
 * "Successful slug migration" detector. Returns true when:
 *   1. `url` is a path like `/events/<slug>` or `/vendors/<slug>`, AND
 *   2. the slug appears as an `old_slug` in `event_slug_history` /
 *      `vendor_slug_history` and resolves (walking up to 5 hops, mirroring
 *      `src/middleware.ts`) to a terminus slug that, AND
 *   3. the terminus URL has a PASS / SUCCESS verdict in
 *      `gsc_inspection_state`.
 *
 * When this returns true, the URL's non-PASS verdict on the old slug is the
 * expected outcome of a rename — Google's URL Inspection reports the source
 * URL non-indexable because it 301s. Flagging it in `health_issues` is noise.
 *
 * Promoter / venue slug history tables don't exist yet — the URL path
 * matcher narrows to events/vendors only. Extend when those tables land.
 */
async function isRedirectToIndexed(db: Db, url: string): Promise<boolean> {
  const path = pathFromUrl(url);
  const match = path.match(/^\/(events|vendors)\/([^/]+)$/);
  if (!match) return false;
  const [, kind, slug] = match;
  let cursor = slug;
  const seen = new Set<string>([cursor]);
  for (let hop = 0; hop < 5; hop++) {
    const [row] =
      kind === "events"
        ? await db
            .select({ newSlug: eventSlugHistory.newSlug })
            .from(eventSlugHistory)
            .where(eq(eventSlugHistory.oldSlug, unsafeSlug(cursor)))
            .orderBy(desc(eventSlugHistory.changedAt))
            .limit(1)
        : await db
            .select({ newSlug: vendorSlugHistory.newSlug })
            .from(vendorSlugHistory)
            .where(eq(vendorSlugHistory.oldSlug, unsafeSlug(cursor)))
            .orderBy(desc(vendorSlugHistory.changedAt))
            .limit(1);
    if (!row || seen.has(row.newSlug)) break;
    cursor = row.newSlug;
    seen.add(cursor);
  }
  if (cursor === slug) return false; // no rename history
  const targetUrl = `${HOST}/${kind}/${cursor}`;
  const [target] = await db
    .select({ verdict: gscInspectionState.lastVerdict })
    .from(gscInspectionState)
    .where(eq(gscInspectionState.url, targetUrl))
    .limit(1);
  return target?.verdict === "PASS" || target?.verdict === "SUCCESS";
}

interface SweepResult {
  inspected: number;
  newIssues: number;
  resolvedIssues: number;
  skipped: number;
  errors: string[];
}

/**
 * A10 — generic open/resolve for a single fingerprinted health issue. Used by
 * the GSC_RICH_RESULT_FAIL path; the legacy GSC_INSPECTION_NON_OK path keeps
 * its own inline block (untouched, to avoid regressing the coverage flow).
 * `failing=false` closes any open issue for the fingerprint (no-op when none).
 */
async function recordHealthIssue(
  db: Db,
  opts: {
    fp: string;
    source: string;
    issueType: string;
    severity: string;
    url: string;
    message: string;
    failing: boolean;
    now: Date;
  },
  result: SweepResult
): Promise<void> {
  const { fp, source, issueType, severity, url, message, failing, now } = opts;
  const [existing] = await db
    .select()
    .from(healthIssues)
    .where(eq(healthIssues.fingerprint, fp))
    .limit(1);

  if (failing) {
    if (existing && !existing.resolvedAt) {
      await db
        .update(healthIssues)
        .set({ lastDetectedAt: now, severity, message })
        .where(eq(healthIssues.id, existing.id));
    } else if (existing) {
      // Re-open a previously-resolved issue.
      await db
        .update(healthIssues)
        .set({ lastDetectedAt: now, resolvedAt: null, severity, message })
        .where(eq(healthIssues.id, existing.id));
      result.newIssues++;
    } else {
      await db.insert(healthIssues).values({
        fingerprint: fp,
        source,
        issueType,
        severity,
        url,
        message,
        firstDetectedAt: now,
        lastDetectedAt: now,
      });
      result.newIssues++;
    }
  } else if (existing && !existing.resolvedAt) {
    await db.update(healthIssues).set({ resolvedAt: now }).where(eq(healthIssues.id, existing.id));
    result.resolvedIssues++;
  }
}

/** Build the prioritized list of URLs to inspect this sweep. */
export async function pickUrls(db: Db, batchSize: number): Promise<string[]> {
  const oneDayAgo = new Date(Date.now() - 86400 * 1000);
  const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000);

  // Tier 1: URLs with non-OK last verdict
  const stale = await db
    .select({ url: gscInspectionState.url })
    .from(gscInspectionState)
    .where(
      and(
        // null verdict means "never inspected" — treat as Tier 3 below
        // anything that's not PASS / SUCCESS we re-inspect first
        or(
          eq(gscInspectionState.lastVerdict, "FAIL"),
          eq(gscInspectionState.lastVerdict, "NEUTRAL"),
          eq(gscInspectionState.lastVerdict, "PARTIAL")
        )
      )
    )
    .limit(batchSize);

  const picked = new Set(stale.map((r) => r.url));

  // Tier 1.5 (A10/A11, 2026-06-26): GUARANTEED per-page-type coverage. The
  // sweep historically inspected almost only /events/ URLs (Tier 2/3 below are
  // event-heavy), so the venue/vendor/promoter/blog "Crawled/Discovered –
  // currently not indexed" defects (A11) were INVISIBLE in persisted data — all
  // 38 GSC_INSPECTION_NON_OK rows were events. Reserve a slice for the
  // least-recently-inspected indexable URL of EACH page type every run. The
  // LEFT JOIN onto gsc_inspection_state sorts never-inspected entities first
  // (SQLite ASC puts NULL `last_inspected_at` ahead), so coverage rotates.
  // Runs BEFORE the early-return so a large Tier-1 backlog can't starve it.
  const PER_TYPE = 10;
  const addByPrefix = (prefix: string, rows: Array<{ slug: string }>) => {
    for (const r of rows) picked.add(`${HOST}${prefix}${r.slug}`);
  };

  const venueSample = await db
    .select({ slug: venues.slug })
    .from(venues)
    .leftJoin(
      gscInspectionState,
      eq(gscInspectionState.url, sql`${HOST} || '/venues/' || ${venues.slug}`)
    )
    .where(eq(venues.status, "ACTIVE"))
    .orderBy(asc(gscInspectionState.lastInspectedAt))
    .limit(PER_TYPE);
  addByPrefix("/venues/", venueSample);

  // Promoters are all public (no status column — see sitemap-promoters).
  const promoterSample = await db
    .select({ slug: promoters.slug })
    .from(promoters)
    .leftJoin(
      gscInspectionState,
      eq(gscInspectionState.url, sql`${HOST} || '/promoters/' || ${promoters.slug}`)
    )
    .orderBy(asc(gscInspectionState.lastInspectedAt))
    .limit(PER_TYPE);
  addByPrefix("/promoters/", promoterSample);

  const blogSample = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .leftJoin(
      gscInspectionState,
      eq(gscInspectionState.url, sql`${HOST} || '/blog/' || ${blogPosts.slug}`)
    )
    .where(eq(blogPosts.status, "PUBLISHED"))
    .orderBy(asc(gscInspectionState.lastInspectedAt))
    .limit(PER_TYPE);
  addByPrefix("/blog/", blogSample);

  const eventSample = await db
    .select({ slug: events.slug })
    .from(events)
    .leftJoin(
      gscInspectionState,
      eq(gscInspectionState.url, sql`${HOST} || '/events/' || ${events.slug}`)
    )
    .where(publicEventWhere())
    .orderBy(asc(gscInspectionState.lastInspectedAt))
    .limit(PER_TYPE);
  addByPrefix("/events/", eventSample);

  // Vendors: reuse the sitemap's exact indexable gate so we never inspect a
  // noindex vendor (false-positive noise). The tier filter runs in TS, so we
  // can't ORDER BY inspection recency in SQL; instead pull the already-inspected
  // vendor URLs (a LIKE scan — avoids the 100-param inArray cap) and sort
  // never/oldest first in JS.
  const indexableVendors = await getIndexableVendorRows(db);
  if (indexableVendors.length > 0) {
    const inspectedVendor = await db
      .select({ url: gscInspectionState.url, last: gscInspectionState.lastInspectedAt })
      .from(gscInspectionState)
      .where(like(gscInspectionState.url, `${HOST}/vendors/%`));
    const lastByUrl = new Map(inspectedVendor.map((r) => [r.url, r.last ? r.last.getTime() : 0]));
    const vendorUrls = indexableVendors
      .map((v) => `${HOST}/vendors/${v.slug}`)
      .sort((a, b) => (lastByUrl.get(a) ?? 0) - (lastByUrl.get(b) ?? 0))
      .slice(0, PER_TYPE);
    for (const u of vendorUrls) picked.add(u);
  }

  if (picked.size >= batchSize) return [...picked].slice(0, batchSize);

  // Tier 2: recently-published events
  const recentEvents = await db
    .select({ slug: events.slug })
    .from(events)
    .where(and(publicEventWhere(), gte(events.updatedAt, oneDayAgo)));
  for (const e of recentEvents) {
    picked.add(`${HOST}/events/${e.slug}`);
    if (picked.size >= batchSize) return [...picked].slice(0, batchSize);
  }

  // Tier 2b: recently-published blog posts
  const recentBlog = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .where(and(eq(blogPosts.status, "PUBLISHED"), gte(blogPosts.updatedAt, oneDayAgo)));
  for (const b of recentBlog) {
    picked.add(`${HOST}/blog/${b.slug}`);
    if (picked.size >= batchSize) return [...picked].slice(0, batchSize);
  }

  // Tier 2c (REL5, 2026-06-16): URLs we've submitted to IndexNow but never
  // resolved a crawl time for. time_to_index_log is seeded on every
  // pingIndexNow with first_crawl_at NULL; the reconciler
  // (sweep-time-to-index) can only set first_crawl_at once gsc_inspection_state
  // has a PASS verdict for that URL. Before this tier, the inspector only ever
  // looked at sitemap / recent / round-robin URLs, so submitted URLs that
  // hadn't already been inspected were invisible — the seed→inspect→reconcile
  // loop had no inspect step for them, and first_crawl_at stayed NULL across
  // all 5,924 rows. Prioritize the oldest unresolved submissions so each daily
  // sweep chips away at measuring them (the rate-limited backfill the §D1 ask
  // describes — there's no instant backfill under GSC's ~2000/day quota).
  if (picked.size < batchSize) {
    const unresolvedSubmitted = await db
      .selectDistinct({ url: timeToIndexLog.url })
      .from(timeToIndexLog)
      .where(isNull(timeToIndexLog.firstCrawlAt))
      .orderBy(asc(timeToIndexLog.indexnowSubmittedAt))
      .limit(batchSize - picked.size);
    for (const r of unresolvedSubmitted) {
      // Only inspect our own-host URLs (the inspector resolves a path against
      // the property); a stray external URL in the log can't be inspected.
      if (r.url.startsWith(HOST)) picked.add(r.url);
      if (picked.size >= batchSize) return [...picked].slice(0, batchSize);
    }
  }

  // Tier 3: round-robin oldest. Pull from gsc_inspection_state ordered by
  // last_inspected_at ASC. Backfill from sitemap URLs if state is empty.
  const oldest = await db
    .select({ url: gscInspectionState.url, lastInspectedAt: gscInspectionState.lastInspectedAt })
    .from(gscInspectionState)
    .orderBy(asc(gscInspectionState.lastInspectedAt))
    .limit(batchSize - picked.size);
  for (const o of oldest) {
    // Skip if already inspected within the cache window (6h)
    if (o.lastInspectedAt && o.lastInspectedAt.getTime() > sixHoursAgo.getTime()) continue;
    picked.add(o.url);
    if (picked.size >= batchSize) return [...picked].slice(0, batchSize);
  }

  // Tier 3 fallback: seed from active events/venues if state is sparse
  if (picked.size < batchSize) {
    const activeEvents = await db
      .select({ slug: events.slug })
      .from(events)
      .where(publicEventWhere())
      .limit(batchSize - picked.size);
    for (const e of activeEvents) {
      picked.add(`${HOST}/events/${e.slug}`);
      if (picked.size >= batchSize) break;
    }
  }
  if (picked.size < batchSize) {
    const activeVenues = await db
      .select({ slug: venues.slug })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"))
      .limit(batchSize - picked.size);
    for (const v of activeVenues) {
      picked.add(`${HOST}/venues/${v.slug}`);
      if (picked.size >= batchSize) break;
    }
  }

  return [...picked];
}

/** Run a single sweep batch. */
export async function runSweep(
  db: Db,
  env: ScEnv,
  opts: { batchSize?: number } = {}
): Promise<SweepResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: SweepResult = {
    inspected: 0,
    newIssues: 0,
    resolvedIssues: 0,
    skipped: 0,
    errors: [],
  };

  const urls = await pickUrls(db, batchSize);
  if (urls.length === 0) return result;

  const now = new Date();

  for (const url of urls) {
    const path = pathFromUrl(url);
    try {
      const inspection = await inspectUrl(env, path);
      const verdict = inspection.index.verdict ?? "UNKNOWN";
      const coverage = inspection.index.coverageState ?? null;
      result.inspected++;

      // Upsert state
      await db
        .insert(gscInspectionState)
        .values({
          url,
          lastInspectedAt: now,
          lastVerdict: verdict,
          lastCoverageState: coverage,
          source: "sitemap",
        })
        .onConflictDoUpdate({
          target: gscInspectionState.url,
          set: { lastInspectedAt: now, lastVerdict: verdict, lastCoverageState: coverage },
        });

      // Record / clear health_issues row for this URL
      const issueType = "GSC_INSPECTION_NON_OK";
      const fp = await fingerprintFor("GSC_URL_INSPECTION", issueType, url);

      // Suppress legitimate slug renames: when the URL is a renamed entity
      // whose terminus is already indexed, GSC's non-PASS verdict on the old
      // URL is expected (it 301s). Treat as effectively passing so any open
      // issue is auto-closed and no new noise row is created.
      const isLegitimateRedirect =
        verdict !== "PASS" && verdict !== "SUCCESS" ? await isRedirectToIndexed(db, url) : false;
      const effectivelyPassing =
        verdict === "PASS" || verdict === "SUCCESS" || isLegitimateRedirect;

      if (!effectivelyPassing) {
        const [existing] = await db
          .select()
          .from(healthIssues)
          .where(eq(healthIssues.fingerprint, fp))
          .limit(1);
        if (existing && !existing.resolvedAt) {
          await db
            .update(healthIssues)
            .set({ lastDetectedAt: now, message: coverage ?? verdict })
            .where(eq(healthIssues.id, existing.id));
        } else if (existing && existing.resolvedAt) {
          // Re-open
          await db
            .update(healthIssues)
            .set({ lastDetectedAt: now, resolvedAt: null, message: coverage ?? verdict })
            .where(eq(healthIssues.id, existing.id));
          result.newIssues++;
        } else {
          await db.insert(healthIssues).values({
            fingerprint: fp,
            source: "GSC_URL_INSPECTION",
            issueType,
            severity: verdict === "FAIL" ? "ERROR" : "WARNING",
            url,
            message: coverage ?? verdict,
            firstDetectedAt: now,
            lastDetectedAt: now,
          });
          result.newIssues++;
        }
      } else {
        // Effectively passing (real PASS/SUCCESS, or legitimate 301-to-indexed)
        // — close any open issue for this URL.
        const [existing] = await db
          .select()
          .from(healthIssues)
          .where(and(eq(healthIssues.fingerprint, fp), isNull(healthIssues.resolvedAt)))
          .limit(1);
        if (existing) {
          await db
            .update(healthIssues)
            .set({ resolvedAt: now })
            .where(eq(healthIssues.id, existing.id));
          result.resolvedIssues++;
        }
      }

      // A10 — the richResults half of the SAME inspection. K46 ("Missing field
      // 'location'" on every event page, 360 GSC errors) lived here unseen for
      // two months because the sweep persisted only coverageState. A FAIL/ERROR
      // rich result becomes its own GSC_RICH_RESULT_FAIL health row (distinct
      // fingerprint from the coverage row, so the two open/resolve independently).
      const rr = summarizeRichResults(inspection.richResults);
      await recordHealthIssue(
        db,
        {
          fp: await fingerprintFor("GSC_URL_INSPECTION", "GSC_RICH_RESULT_FAIL", url),
          source: "GSC_URL_INSPECTION",
          issueType: "GSC_RICH_RESULT_FAIL",
          severity: rr?.severity ?? "ERROR",
          url,
          message: rr?.message ?? "",
          failing: rr?.failing ?? false,
          now,
        },
        result
      );
    } catch (error) {
      if (error instanceof ScConfigError) {
        result.errors.push(`config: ${error.message}`);
        // No point continuing — every call will fail the same way
        break;
      }
      if (error instanceof ScApiError && error.status === 429) {
        // Daily quota — stop, retry tomorrow
        result.errors.push(`quota: ${error.detail}`);
        break;
      }
      result.skipped++;
      result.errors.push(`${url}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  return result;
}
