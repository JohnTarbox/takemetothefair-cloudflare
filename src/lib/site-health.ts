/**
 * Site Health unified panel — pulls issues from Bing Site Scan, Bing/GSC
 * sitemap warnings, and the rolling GSC URL Inspection sweep, normalizes them
 * into a common row shape, and persists to D1 so snoozes survive across
 * refreshes.
 *
 * Source aggregator. The actual GSC sweep lives in src/lib/gsc-sweep.ts.
 */

import { eq, and, isNull, or, sql, gte, desc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { healthIssues, healthIssueSnoozes, gscInspectionState } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import {
  getSiteScanIssues,
  getSitemaps as getBingSitemaps,
  type BingEnv,
} from "@/lib/bing-webmaster";
import { getSitemapStatus, type ScEnv } from "@/lib/search-console";

type Db = DrizzleD1Database<typeof schema>;

export type HealthSource = "BING_SCAN" | "BING_SITEMAP" | "GSC_SITEMAP" | "GSC_URL_INSPECTION";

export type HealthSeverity = "ERROR" | "WARNING" | "NOTICE";

export interface HealthRow {
  fingerprint: string;
  source: HealthSource;
  issueType: string;
  severity: HealthSeverity;
  url: string | null;
  message: string | null;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  resolvedAt: Date | null;
  snoozedUntil: Date | null;
}

/** Stable fingerprint for an issue. Lower-cases the URL so trivial casing
 *  variations don't fragment snoozes. Uses crypto.subtle.digest so the value
 *  is deterministic across Workers instances. */
async function fingerprintFor(
  source: HealthSource,
  issueType: string,
  url: string | null
): Promise<string> {
  const normalizedUrl = url?.toLowerCase() ?? "";
  const seed = `${source}|${issueType}|${normalizedUrl}`;
  const buf = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

interface NormalizedIssue {
  source: HealthSource;
  issueType: string;
  severity: HealthSeverity;
  url: string | null;
  message: string | null;
}

/** Pull fresh issues from every source. Each provider failure is contained so
 *  a single transient outage doesn't blank the whole panel. */
async function collectFreshIssues(bingEnv: BingEnv, scEnv: ScEnv): Promise<NormalizedIssue[]> {
  const issues: NormalizedIssue[] = [];

  // Bing Site Scan
  try {
    const scan = await getSiteScanIssues(bingEnv);
    for (const i of scan) {
      const sev: HealthSeverity =
        i.severity === "Error" ? "ERROR" : i.severity === "Warning" ? "WARNING" : "NOTICE";
      if (i.affectedUrls.length === 0) {
        issues.push({
          source: "BING_SCAN",
          issueType: i.issueType,
          severity: sev,
          url: null,
          message: `${i.affectedUrlCount} affected URLs`,
        });
      } else {
        for (const url of i.affectedUrls) {
          issues.push({
            source: "BING_SCAN",
            issueType: i.issueType,
            severity: sev,
            url,
            message: null,
          });
        }
      }
    }
  } catch (error) {
    console.warn("[site-health] BING_SCAN failed:", error);
  }

  // Bing sitemap status — extract any non-Success entries
  try {
    const bingSitemaps = await getBingSitemaps(bingEnv);
    for (const s of bingSitemaps) {
      if (s.status && s.status !== "Success" && s.status !== "Indexed") {
        issues.push({
          source: "BING_SITEMAP",
          issueType: `SITEMAP_${s.status.toUpperCase().replace(/\s+/g, "_")}`,
          severity: "WARNING",
          url: s.url,
          message: `${s.urlCount} URLs · status ${s.status}`,
        });
      }
    }
  } catch (error) {
    console.warn("[site-health] BING_SITEMAP failed:", error);
  }

  // GSC sitemap status — surface warnings + errors as issues
  try {
    const gscStatus = await getSitemapStatus(scEnv);
    for (const s of gscStatus.sitemaps) {
      if ((s.errors ?? 0) > 0) {
        issues.push({
          source: "GSC_SITEMAP",
          issueType: "GSC_SITEMAP_ERRORS",
          severity: "ERROR",
          url: s.path,
          message: `${s.errors} errors`,
        });
      }
      if ((s.warnings ?? 0) > 0) {
        issues.push({
          source: "GSC_SITEMAP",
          issueType: "GSC_SITEMAP_WARNINGS",
          severity: "WARNING",
          url: s.path,
          message: `${s.warnings} warnings`,
        });
      }
    }
  } catch (error) {
    console.warn("[site-health] GSC_SITEMAP failed:", error);
  }

  return issues;
}

/** Reconcile a fresh batch of issues with the persisted snapshot.
 *  - New issues → insert
 *  - Existing open issues seen again → bump last_detected_at
 *  - Existing open issues NOT in fresh batch → mark resolved_at
 *  Returns the count of inserted/updated/closed rows for telemetry. */
export async function refreshIssues(
  db: Db,
  bingEnv: BingEnv,
  scEnv: ScEnv
): Promise<{ inserted: number; updated: number; resolved: number }> {
  const fresh = await collectFreshIssues(bingEnv, scEnv);
  const now = new Date();

  // Pre-compute fingerprints for the fresh batch
  const freshWithFp = await Promise.all(
    fresh.map(async (issue) => ({
      ...issue,
      fingerprint: await fingerprintFor(issue.source, issue.issueType, issue.url),
    }))
  );
  const freshFingerprints = new Set(freshWithFp.map((f) => f.fingerprint));

  // Pull current open issues
  const openRows = await db.select().from(healthIssues).where(isNull(healthIssues.resolvedAt));
  const openByFingerprint = new Map(openRows.map((r) => [r.fingerprint, r]));

  let inserted = 0;
  let updated = 0;
  let resolved = 0;

  for (const f of freshWithFp) {
    const existing = openByFingerprint.get(f.fingerprint);
    if (existing) {
      await db
        .update(healthIssues)
        .set({ lastDetectedAt: now, message: f.message })
        .where(eq(healthIssues.id, existing.id));
      updated++;
    } else {
      await db.insert(healthIssues).values({
        fingerprint: f.fingerprint,
        source: f.source,
        issueType: f.issueType,
        severity: f.severity,
        url: f.url,
        message: f.message,
        firstDetectedAt: now,
        lastDetectedAt: now,
      });
      inserted++;
    }
  }

  // Resolve open issues no longer present in the fresh batch
  for (const row of openRows) {
    if (!freshFingerprints.has(row.fingerprint)) {
      await db.update(healthIssues).set({ resolvedAt: now }).where(eq(healthIssues.id, row.id));
      resolved++;
    }
  }

  return { inserted, updated, resolved };
}

/** List currently-open issues with snooze state attached. Optionally filter
 *  out actively-snoozed rows. */
export async function getCurrentIssues(
  db: Db,
  opts: { hideSnoozed?: boolean; source?: HealthSource; severity?: HealthSeverity } = {}
): Promise<HealthRow[]> {
  const now = new Date();

  // Single LEFT JOIN to fold in snooze state.
  const rawRows = await db
    .select({
      fingerprint: healthIssues.fingerprint,
      source: healthIssues.source,
      issueType: healthIssues.issueType,
      severity: healthIssues.severity,
      url: healthIssues.url,
      message: healthIssues.message,
      firstDetectedAt: healthIssues.firstDetectedAt,
      lastDetectedAt: healthIssues.lastDetectedAt,
      resolvedAt: healthIssues.resolvedAt,
      snoozedUntil: healthIssueSnoozes.snoozedUntil,
    })
    .from(healthIssues)
    .leftJoin(healthIssueSnoozes, eq(healthIssues.fingerprint, healthIssueSnoozes.fingerprint))
    .where(isNull(healthIssues.resolvedAt))
    .orderBy(desc(healthIssues.lastDetectedAt));

  const rows: HealthRow[] = rawRows.map((r) => ({
    fingerprint: r.fingerprint,
    source: r.source as HealthSource,
    issueType: r.issueType,
    severity: r.severity as HealthSeverity,
    url: r.url,
    message: r.message,
    firstDetectedAt: r.firstDetectedAt,
    lastDetectedAt: r.lastDetectedAt,
    resolvedAt: r.resolvedAt,
    snoozedUntil: r.snoozedUntil,
  }));

  return rows.filter((row) => {
    if (opts.source && row.source !== opts.source) return false;
    if (opts.severity && row.severity !== opts.severity) return false;
    if (opts.hideSnoozed && row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime())
      return false;
    return true;
  });
}

/** Snooze an issue for `days` days. Upserts the snooze row. */
export async function snoozeIssue(
  db: Db,
  fingerprint: string,
  days: number,
  userId: string,
  note?: string
): Promise<void> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400 * 1000);
  // SQLite UPSERT via insert + ON CONFLICT — keeps the operation atomic.
  await db
    .insert(healthIssueSnoozes)
    .values({
      fingerprint,
      snoozedUntil: until,
      snoozedBy: userId,
      snoozedAt: now,
      note: note ?? null,
    })
    .onConflictDoUpdate({
      target: healthIssueSnoozes.fingerprint,
      set: {
        snoozedUntil: until,
        snoozedBy: userId,
        snoozedAt: now,
        note: note ?? null,
      },
    });
}

/** Remove a snooze. */
export async function unsnoozeIssue(db: Db, fingerprint: string): Promise<void> {
  await db.delete(healthIssueSnoozes).where(eq(healthIssueSnoozes.fingerprint, fingerprint));
}

/** Compute fingerprint for an external caller (API route / MCP tool). */
export { fingerprintFor };

// Reference unused imports to keep tree-shaking happy when only some helpers
// are used. The drizzle helpers below are imported for the eventual gsc-sweep
// integration in this file; remove if/when the sweep grows its own module.
void or;
void and;
void sql;
void gte;
void gscInspectionState;
