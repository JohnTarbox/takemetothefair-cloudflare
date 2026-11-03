export const dynamic = "force-dynamic";
/**
 * OPE-1270 — re-read every vendor's own website, the one stored outbound link
 * class nothing ever checked.
 *
 * On the promoter sweep's pattern (OPE-860/868): same table, same probe
 * (url-probe.ts), its own `source_field`, its own heartbeat probe. Two things
 * differ, both on purpose:
 *
 * ## What "healthy" means (vendor-site-health.ts)
 *
 * A vendor's site has no fair dates on it, so the organizer classifier's
 * event-signal test would call nearly every healthy vendor site
 * `no_event_signal`. The vendor classifier keeps the base verdicts that are
 * right for any site (unreachable / http_error / closure_notice / takeover)
 * and adds `empty_page` and `moved` — the latter is the acceptance specimen,
 * `baystatesavingsbank.com` 302-ing to `baystatebank.com`, which a plain
 * up/down check reads as healthy.
 *
 * ## Rotation instead of a cursor
 *
 * Prod, 2026-10-02: 9,840 vendors, 3,270 live with a website, **3,181 DISTINCT
 * websites** — the ticket's ~7,061 counted records, not sites. At chunk=50 that
 * is 64 chunks, more than one daily run should spend. So each call takes the 50
 * sites checked LONGEST ago (never-checked first), and the daily driver runs a
 * bounded number of chunks: the estate rotates every few days with no cursor to
 * persist, and a missed day just means the next run picks up the oldest.
 *
 * The chunk size is the promoter sweep's MEASURED one for the identical
 * operation (50 × one per-URL fetch ≈ 30–45s, under the ~100s edge budget).
 *
 * ## ⚠️ This never writes to the vendor
 *
 * Name drift is detected and queued for an operator (site-health, INFO). A
 * rename moves a public URL, and OPE-495 / OPE-1183 show renames orphan slugs
 * when history is not written — so no `business_name` and no `website` is ever
 * touched here.
 */
import { bodyBytesOf } from "@/lib/goodwill/url-health";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { urlHealthChecks } from "@/lib/db/schema";
import { probe } from "@/lib/goodwill/url-probe";
import { classifyVendorSite, type VendorSiteVerdict } from "@/lib/goodwill/vendor-site-health";
import { projectUrlHealthFlag, projectUrlHealthVerdict } from "@/lib/url-health-issues";
import { logError } from "@/lib/logger";

const DEFAULT_CHUNK = 50;
const MAX_CHUNK = 100;

/** Not exported: a route module may only export the verbs + config names. */
const SOURCE_FIELD = "vendors.website";

/** A check older than this no longer counts toward "recently checked". */
const ROTATION_LOOKBACK_DAYS = 60;

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const chunk = Math.min(
    MAX_CHUNK,
    Math.max(1, Number(url.searchParams.get("chunk") ?? 0) || DEFAULT_CHUNK)
  );

  const db = getCloudflareDb();
  const now = new Date();
  const lookback = Math.floor(now.getTime() / 1000) - ROTATION_LOOKBACK_DAYS * 86400;

  try {
    // One row per DISTINCT live website, least-recently-checked first.
    // MAX(checked_at) per URL over a bounded window keeps the aggregate small
    // as the table grows; NULL (never checked) sorts first in SQLite ASC.
    const rows = await db.all<{ website: string; name: string | null; last: number | null }>(sql`
      SELECT v.website AS website, MIN(v.business_name) AS name, h.last AS last
      FROM vendors v
      LEFT JOIN (
        SELECT url, MAX(checked_at) AS last
        FROM url_health_checks
        WHERE source_field = ${SOURCE_FIELD} AND checked_at >= ${lookback}
        GROUP BY url
      ) h ON h.url = v.website
      WHERE v.website IS NOT NULL AND v.website <> '' AND v.deleted_at IS NULL
      GROUP BY v.website
      ORDER BY h.last ASC, v.website ASC
      LIMIT ${chunk}
    `);

    const counts: Record<VendorSiteVerdict, number> = {
      ok: 0,
      unreachable: 0,
      http_error: 0,
      closure_notice: 0,
      domain_takeover: 0,
      empty_page: 0,
      moved: 0,
      blocked: 0,
    };
    const result = {
      success: true,
      chunk,
      /**
       * Positive landmark: a selector that silently stops matching reports zero
       * flagged and reads as a clean bill of health. `examined` is the tell.
       */
      examined: rows.length,
      ...counts,
      name_drift: 0,
      name_unknown: 0,
      issues_opened: 0,
      issues_resolved: 0,
      issues_projection_failed: 0,
      /** How many of this chunk had never been checked before. */
      never_checked_before: rows.filter((r) => r.last == null).length,
    };

    for (const r of rows) {
      const website = (r.website ?? "").trim();
      if (!website) continue;
      const p = await probe(website);
      const v = classifyVendorSite(p, { requestedUrl: website, businessName: r.name });

      await db.insert(urlHealthChecks).values({
        url: website,
        sourceField: SOURCE_FIELD,
        verdict: v.verdict,
        httpStatus: p.status,
        signals: v.signals.join(",") || null,
        detail: v.detail,
        // OPE-1294 — the raw size, so a parked shell is separable from a bot wall.
        bodyBytes: bodyBytesOf(p.html),
        checkedAt: now,
      });

      result[v.verdict] += 1;
      if (v.nameDrift.drift === true) result.name_drift += 1;
      if (v.nameDrift.drift === null) result.name_unknown += 1;

      // The queue half (OPE-1280's consumer, inherited — no vendor branch in it).
      try {
        const a = await projectUrlHealthVerdict(db, {
          sourceField: SOURCE_FIELD,
          url: website,
          verdict: v.verdict,
          httpStatus: p.status,
          checkedAt: now,
        });
        const b = await projectUrlHealthFlag(db, {
          sourceField: SOURCE_FIELD,
          url: website,
          flag: "name_drift",
          present: v.nameDrift.drift,
          checkedAt: now,
          evidence:
            v.nameDrift.drift === true
              ? // A `"` inside a name would break the grouping key's quote folding.
                `ours "${(r.name ?? "").replace(/"/g, "'").slice(0, 80)}" · site "${v.nameDrift.declared
                  .join(" | ")
                  .replace(/"/g, "'")
                  .slice(0, 120)}"`
              : null,
        });
        result.issues_opened += a.opened + a.reopened + b.opened + b.reopened;
        result.issues_resolved += a.resolved + b.resolved;
      } catch (projectErr) {
        result.issues_projection_failed += 1;
        await logError(db, {
          level: "warn",
          message: "vendor url-health → health_issues projection failed",
          error: projectErr,
          source: "api/admin/url-health/vendors/sweep",
          context: { website, verdict: v.verdict },
        });
      }

      if (v.verdict === "domain_takeover" || v.verdict === "closure_notice") {
        await logError(db, {
          level: "warn",
          message: `vendor website ${v.verdict === "domain_takeover" ? "looks taken over" : "announces closure/handover"}: ${website}`,
          source: `url-health:vendor-${v.verdict.replace("_", "-")}`,
          context: { website, finalUrl: p.finalUrl, detail: v.detail, signals: v.signals },
        });
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    await logError(db, {
      message: "vendor url-health sweep threw",
      error,
      source: "api/admin/url-health/vendors/sweep",
      request,
    });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

/**
 * GET — the population report (OPE-1270 scope 5): the LATEST verdict per vendor
 * website, counted, plus name drift. Read-only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getCloudflareDb();
  try {
    const byVerdict = await db.all<{ verdict: string; urls: number }>(sql`
      WITH ranked AS (
        SELECT url, verdict, signals,
               ROW_NUMBER() OVER (PARTITION BY url ORDER BY checked_at DESC, rowid DESC) AS rn
        FROM url_health_checks
        WHERE source_field = ${SOURCE_FIELD}
      )
      SELECT verdict, COUNT(*) AS urls FROM ranked WHERE rn = 1 GROUP BY verdict
    `);
    const [drift] = await db.all<{ drifted: number; checked: number }>(sql`
      WITH ranked AS (
        SELECT url, signals,
               ROW_NUMBER() OVER (PARTITION BY url ORDER BY checked_at DESC, rowid DESC) AS rn
        FROM url_health_checks
        WHERE source_field = ${SOURCE_FIELD}
      )
      SELECT SUM(instr(COALESCE(signals, ''), 'name-drift:') > 0) AS drifted, COUNT(*) AS checked
      FROM ranked WHERE rn = 1
    `);
    const [pop] = await db.all<{ sites: number }>(sql`
      SELECT COUNT(DISTINCT website) AS sites FROM vendors
      WHERE website IS NOT NULL AND website <> '' AND deleted_at IS NULL
    `);
    return NextResponse.json({
      success: true,
      population_distinct_sites: pop?.sites ?? 0,
      sites_checked: drift?.checked ?? 0,
      latest_verdicts: Object.fromEntries(byVerdict.map((r) => [r.verdict, r.urls])),
      name_drift: drift?.drifted ?? 0,
      note: "Advisory only. Nothing renames a vendor or rewrites its website on this report.",
    });
  } catch (error) {
    await logError(db, {
      message: "vendor url-health report threw",
      error,
      source: "api/admin/url-health/vendors/sweep",
      request,
    });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
}
