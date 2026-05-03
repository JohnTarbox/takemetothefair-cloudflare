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

import { eq, and, gte, inArray, asc, isNull, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { events, venues, blogPosts, gscInspectionState, healthIssues } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { SITE_URL } from "@takemetothefair/constants";
import { inspectUrl, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { fingerprintFor } from "@/lib/site-health";

type Db = DrizzleD1Database<typeof schema>;

const DEFAULT_BATCH_SIZE = 200;
const HOST = SITE_URL;

function pathFromUrl(url: string): string {
  return url.replace(HOST, "") || "/";
}

interface SweepResult {
  inspected: number;
  newIssues: number;
  resolvedIssues: number;
  skipped: number;
  errors: string[];
}

/** Build the prioritized list of URLs to inspect this sweep. */
async function pickUrls(db: Db, batchSize: number): Promise<string[]> {
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
  if (picked.size >= batchSize) return [...picked].slice(0, batchSize);

  // Tier 2: recently-published events
  const recentEvents = await db
    .select({ slug: events.slug })
    .from(events)
    .where(
      and(inArray(events.status, [...PUBLIC_EVENT_STATUSES]), gte(events.updatedAt, oneDayAgo))
    );
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
      .where(inArray(events.status, [...PUBLIC_EVENT_STATUSES]))
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

      if (verdict !== "PASS" && verdict !== "SUCCESS") {
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
        // Pass — close any open issue for this URL
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
