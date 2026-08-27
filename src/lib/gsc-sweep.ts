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

import {
  eq,
  and,
  gte,
  lt,
  asc,
  desc,
  isNull,
  isNotNull,
  or,
  like,
  sql,
  inArray,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  events,
  eventSeries,
  venues,
  promoters,
  blogPosts,
  gscInspectionState,
  healthIssues,
  emailSendLedger,
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
import { buildPageLastChangedMap } from "@/lib/gsc-page-last-changed";
import { reverifyHealthIssue, LOCALLY_DECIDABLE_SQL_PROBES } from "@/lib/site-health-reverify";
import { HEALTH_RESOLUTION_REASON } from "@takemetothefair/db-schema";
import { getIndexableVendorRows } from "@/lib/sitemap/indexable-vendors";
import {
  getIndexableEventRows,
  getCanonicalEventUrlSet,
  canonicalEventPath,
  collectCanonicalEventPaths,
} from "@/lib/sitemap/indexable-events";

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
  /** OPE-373 — closures broken out by reason. A single total cannot tell
   *  "we proved it fixed" from "we stopped looking", and those are the two
   *  facts that matter most when reading this queue. */
  resolvedByReason?: Record<string, number>;
}

/**
 * OPE-373 — how many scan cycles of not being seen before a row is expired.
 *
 * The sweep runs daily, so 21 days is three weeks of the scan never once
 * re-observing the condition. Chosen rather than something tighter because the
 * rotation is slow by design: ~2,200 sitemap URLs against ~50-60 inspected per
 * run means a given URL comes round roughly monthly, and a shorter window would
 * expire rows that are merely waiting their turn — closing them as "no longer
 * detected" when the truth is "not yet re-checked". That mistake is worse than
 * a stale row, because it manufactures a false recovery.
 *
 * Override with SITE_HEALTH_EXPIRE_DAYS.
 */
export const DEFAULT_EXPIRE_DAYS = 21;

/**
 * OPE-382 — how many re-verify fetches run at once.
 *
 * These are requests to our OWN origin, so the ceiling is Cloudflare's subrequest
 * budget and our own tolerance, not a third party's rate limit. 8 turns a 40-row
 * batch into 5 waves instead of 40 sequential round-trips, which is what brought
 * `run_site_health_sweep(batch_size=0)` back inside the 60s MCP budget. Kept
 * modest deliberately: this runs alongside the GSC calls in the same invocation.
 */
const REVERIFY_CONCURRENCY = 8;

/**
 * OPE-373 item 4 — severity by ACTIONABILITY, not by GSC's verdict string.
 *
 * Before: `verdict === "FAIL" ? "ERROR" : "WARNING"`, which is a restatement of
 * what Google said rather than a judgement about what we should do. It put a
 * self-healed transient 5xx and a page nobody can fix at the same level, and
 * flagged our own correct 301 as a WARNING.
 *
 * The three levels mean:
 *   ERROR   the page is broken for users right now — someone should act today
 *   WARNING we did something wrong that we can fix (a page we publish is
 *           noindex'd, or 404s)
 *   INFO    Google's indexing choice, or a crawl-lag artefact. Real signal in
 *           aggregate, but there is no per-URL action, so it must not compete
 *           for attention with the two above.
 */
export function severityForCoverage(coverage: string | null, verdict: string): string {
  const c = (coverage ?? "").toLowerCase().replace(/[‘’‛ʼ]/g, "'");
  if (c.includes("server error")) return "ERROR";
  if (c.includes("not found (404)") || c.includes("soft 404")) return "ERROR";
  if (c.includes("excluded by 'noindex' tag")) return "WARNING";
  if (c.includes("blocked by robots.txt")) return "WARNING";
  // "Crawled – currently not indexed", "Discovered – currently not indexed",
  // "URL is unknown to Google", "Page with redirect", "Alternate page with
  // canonical" — all descriptions of Google's own state, not defects we can
  // action per-URL.
  if (
    c.includes("currently not indexed") ||
    c.includes("unknown to google") ||
    c.includes("page with redirect") ||
    c.includes("alternate page")
  ) {
    return "INFO";
  }
  return verdict === "FAIL" ? "ERROR" : "WARNING";
}

function expireDaysFrom(env: { SITE_HEALTH_EXPIRE_DAYS?: string }): number {
  const raw = Number(env.SITE_HEALTH_EXPIRE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRE_DAYS;
}

/**
 * OPE-369 — surface stubbed sends where a human will actually see them.
 *
 * `email_send_ledger.status='stubbed'` means the send was never attempted: the
 * direct `sendEmail()` path falls back to a stub whenever RESEND_API_KEY is
 * unset, which it has never been in production. All 26 `indexnow:health` rows
 * across a full month are stubbed, so the alert warning us that an integration
 * had gone silent was itself silent — discoverable only by querying the ledger
 * by status, which is exactly how it was eventually found.
 *
 * A regression sweep for this already existed at `/api/admin/email-stub-check`
 * and NOTHING has ever called it. It is referenced in one comment and nowhere
 * else. That is the whole defect in miniature: the detector was built and never
 * wired, so it could not report the failure it was written for.
 *
 * ── Why this reports into health_issues rather than by email ────────────────
 * Because the broken channel IS email. Alerting about undelivered mail by
 * sending mail is the mistake of announcing a fire over the intercom that is on
 * fire. `health_issues` is durable, is now bucketed and re-verified (OPE-373),
 * and is read without depending on the thing under test.
 *
 * Uses the shared fingerprint helper, so the row auto-closes on the first sweep
 * that finds a clean window — the same open/resolve lifecycle as every other
 * health issue, no bespoke state.
 */
export async function checkStubbedSends(
  db: Db,
  now: Date,
  result: SweepResult,
  windowHours = 48
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowHours * 3600 * 1000);
  const stubbed = await db
    .select({ source: emailSendLedger.source, subject: emailSendLedger.subject })
    .from(emailSendLedger)
    .where(and(eq(emailSendLedger.status, "stubbed"), gte(emailSendLedger.sentAt, cutoff)));

  const fp = await fingerprintFor("EMAIL_DELIVERY", "EMAIL_SEND_STUBBED", "ledger");
  const sources = [...new Set(stubbed.map((r) => r.source).filter(Boolean))];

  await recordHealthIssue(
    db,
    {
      fp,
      source: "EMAIL_DELIVERY",
      issueType: "EMAIL_SEND_STUBBED",
      // ERROR, not WARNING: a stubbed send is mail an operator believes was
      // delivered and was not. Every other severity judgement in this file is
      // about pages; this one is about someone not being told something.
      severity: "ERROR",
      url: `${HOST}/admin/analytics`,
      message: `${stubbed.length} email(s) stubbed (never sent) in the last ${windowHours}h — sources: ${sources.join(", ") || "n/a"}`,
      failing: stubbed.length > 0,
      now,
    },
    result
  );
  return stubbed.length;
}

/**
 * OPE-373 — re-stamp severity on open rows from the current taxonomy.
 *
 * Severity is written once, at insert. So shipping `severityForCoverage` only
 * changed rows created after the deploy: immediately afterwards production held
 * 211 open rows on the OLD taxonomy and exactly 1 on the new one, which makes
 * the bucketed report worse than useless — it would show two rows with the same
 * `message` at different severities purely by age.
 *
 * Deliberately re-derived through the SAME function the insert path uses rather
 * than a parallel SQL CASE. A backfill that reimplements the rule is how the two
 * copies drift, which is precisely the defect OPE-372 was about.
 *
 * Pure and cheap — no network, no GSC quota, decided entirely from `message`.
 */
export async function refreshOpenSeverities(db: Db): Promise<number> {
  const open = await db
    .select({ id: healthIssues.id, message: healthIssues.message, severity: healthIssues.severity })
    .from(healthIssues)
    .where(isNull(healthIssues.resolvedAt));

  let updated = 0;
  for (const row of open) {
    // Rich-result rows carry a "FAIL: ..." message rather than a GSC coverage
    // state; pass the verdict through so they keep resolving to ERROR.
    const next = severityForCoverage(
      row.message,
      row.message?.startsWith("FAIL") ? "FAIL" : "NEUTRAL"
    );
    if (next === row.severity) continue;
    await db.update(healthIssues).set({ severity: next }).where(eq(healthIssues.id, row.id));
    updated++;
  }
  return updated;
}

/**
 * OPE-373 — resolve open rows whose condition our own server disproves.
 *
 * Only touches locally-decidable classes (noindex / 5xx / 404). Anything the
 * origin cannot settle is left alone: a 200 from us says nothing about whether
 * Google chose to index a page, so "Crawled – currently not indexed" and
 * friends stay with GSC and the expiry path.
 *
 * Bounded per run because each row is a live HTTP fetch and the sweep shares
 * Cloudflare's request budget with the GSC calls.
 */
export async function reverifyOpenIssues(
  db: Db,
  now: Date,
  result: SweepResult,
  opts: { limit?: number; fetchImpl?: typeof fetch; concurrency?: number } = {}
): Promise<number> {
  const limit = opts.limit ?? 40;
  const concurrency = opts.concurrency ?? REVERIFY_CONCURRENCY;

  // OPE-382 — only pull rows this pass can actually settle. 90 of the 159 open
  // rows measured 2026-08-13 were GSC-index facts ("URL is unknown to Google",
  // "Crawled - currently not indexed") that a 200 from our origin cannot
  // contradict; fetching them spent the budget proving nothing and starved the
  // decidable tail behind them.
  const decidable = or(
    ...LOCALLY_DECIDABLE_SQL_PROBES.map((probe) =>
      like(sql`lower(${healthIssues.message})`, `%${probe}%`)
    )
  );

  const open = await db
    .select({ id: healthIssues.id, url: healthIssues.url, message: healthIssues.message })
    .from(healthIssues)
    .where(
      and(
        eq(healthIssues.issueType, "GSC_INSPECTION_NON_OK"),
        isNull(healthIssues.resolvedAt),
        decidable
      )
    )
    // OPE-382 — order by OUR cursor, not by the scan's `last_detected_at`.
    // Sorting by when the scan last saw a row means a row we cannot close keeps
    // its place forever and the same head is re-fetched every run; that is how
    // the two 5xx rows sat at ranks 80 and 107 behind a limit of 40 and were
    // never once fetched. NULL (never attempted) sorts first in SQLite ASC.
    .orderBy(asc(healthIssues.lastReverifiedAt), asc(healthIssues.lastDetectedAt))
    .limit(limit);

  // Bounded-concurrency fetches. Previously 40 sequential live HTTP requests ran
  // even on a sweep that inspected nothing (the maintenance passes run before
  // the early return), which is what made `run_site_health_sweep(batch_size=0)`
  // exceed both the 60s MCP and 180s edge budgets.
  const outcomes: { id: string; message: string | null; fixed: boolean; detail: string }[] = [];
  for (let i = 0; i < open.length; i += concurrency) {
    const slice = open.slice(i, i + concurrency);
    const settled = await Promise.all(
      slice.map(async (row) => {
        if (!row.url) return null;
        const outcome = await reverifyHealthIssue(row.url, row.message, {
          fetchImpl: opts.fetchImpl,
        });
        // Undecidable leaves the row open — a check we could not perform is not
        // evidence of recovery.
        const fixed = outcome.decidable && !outcome.stillFailing;
        return { id: row.id, message: row.message, fixed, detail: outcome.detail };
      })
    );
    for (const s of settled) if (s) outcomes.push(s);
  }

  // Stamp the cursor for EVERY row we attempted, whatever the verdict. A row
  // that stays open because it is genuinely still broken must still advance, or
  // one permanently-500ing page rebuilds the head-of-line block this fixes.
  // Chunked well under D1's 100-parameter statement limit.
  const attempted = outcomes.map((o) => o.id);
  for (let i = 0; i < attempted.length; i += 50) {
    await db
      .update(healthIssues)
      .set({ lastReverifiedAt: now })
      .where(inArray(healthIssues.id, attempted.slice(i, i + 50)));
  }

  let resolved = 0;
  for (const outcome of outcomes) {
    if (!outcome.fixed) continue;
    await db
      .update(healthIssues)
      .set({
        resolvedAt: now,
        resolutionReason: HEALTH_RESOLUTION_REASON.VERIFIED_FIXED,
        message: `${outcome.message} — resolved: ${outcome.detail}`,
      })
      .where(eq(healthIssues.id, outcome.id));
    resolved++;
  }
  if (resolved > 0) {
    result.resolvedIssues += resolved;
    result.resolvedByReason = {
      ...result.resolvedByReason,
      [HEALTH_RESOLUTION_REASON.VERIFIED_FIXED]:
        (result.resolvedByReason?.[HEALTH_RESOLUTION_REASON.VERIFIED_FIXED] ?? 0) + resolved,
    };
  }
  return resolved;
}

/**
 * OPE-373 — expire rows the scan has stopped observing.
 *
 * Closed as `no_longer_detected`, NEVER as fixed. The distinction is the whole
 * point of the reason column: this closure is consistent with the problem
 * having gone away AND with our having gone blind to it, and a reader must be
 * able to tell that apart from a verified recovery.
 */
export async function expireUndetectedIssues(
  db: Db,
  now: Date,
  expireDays: number,
  result: SweepResult
): Promise<number> {
  const cutoff = new Date(now.getTime() - expireDays * 86400 * 1000);
  const stale = await db
    .select({ id: healthIssues.id })
    .from(healthIssues)
    .where(and(isNull(healthIssues.resolvedAt), lt(healthIssues.lastDetectedAt, cutoff)));

  let resolved = 0;
  for (const row of stale) {
    await db
      .update(healthIssues)
      .set({ resolvedAt: now, resolutionReason: HEALTH_RESOLUTION_REASON.NO_LONGER_DETECTED })
      .where(eq(healthIssues.id, row.id));
    resolved++;
  }
  if (resolved > 0) {
    result.resolvedIssues += resolved;
    result.resolvedByReason = {
      ...result.resolvedByReason,
      [HEALTH_RESOLUTION_REASON.NO_LONGER_DETECTED]:
        (result.resolvedByReason?.[HEALTH_RESOLUTION_REASON.NO_LONGER_DETECTED] ?? 0) + resolved,
    };
  }
  return resolved;
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

/**
 * Build the prioritized list of URLs to inspect this sweep.
 *
 * ⚠️ NOT read-only despite the name: Tier 0 stamps `last_reverified_at` on the
 * rows it selects, because a rotation cursor that nothing advances is not a
 * rotation. The only production caller is `runSweep`.
 */
export async function pickUrls(
  db: Db,
  batchSize: number,
  /** OPE-372 — the canonical allow-list. Optional so existing callers and tests
   *  keep working; runSweep passes the set it already computed rather than
   *  paying for the same query twice. */
  precomputedCanonicalEventUrls?: Set<string>,
  /** Injected so the Tier 0 cursor stamp is deterministic under test; runSweep
   *  passes the same `now` it uses everywhere else in the pass. */
  now: Date = new Date()
): Promise<string[]> {
  const oneDayAgo = new Date(Date.now() - 86400 * 1000);
  const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000);

  // Tier 1.5 (A10/A11, 2026-06-26): GUARANTEED per-page-type coverage. The
  // sweep historically inspected almost only /events/ URLs (Tier 2/3 below are
  // event-heavy), so the venue/vendor/promoter/blog "Crawled/Discovered –
  // currently not indexed" defects (A11) were INVISIBLE in persisted data — all
  // 38 GSC_INSPECTION_NON_OK rows were events. Reserve a slice for the
  // least-recently-inspected indexable URL of EACH page type every run. The
  // LEFT JOIN onto gsc_inspection_state sorts never-inspected entities first
  // (SQLite ASC puts NULL `last_inspected_at` ahead), so coverage rotates.
  //
  // OPE-91 (2026-07-04): this per-type set is now built into its own
  // `guaranteed` Set and is NEVER truncated. Previously it was mixed into a
  // single `picked` Set together with Tier 1, then the function did
  // `[...picked].slice(0, batchSize)` at the end. With the default batchSize=8
  // and a full Tier-1 backlog, that slice DISCARDED every per-type URL (the Set
  // is insertion-ordered and Tier 1 was inserted first), so blog/vendor/venue/
  // promoter were never inspected — gsc_inspection_state had 0 blog rows and
  // /admin/blog showed "unknown" for every post. We now return
  // `[...guaranteed, ...filler]`: the guaranteed per-type coverage always ships
  // in full, and the Tier 1 / 2 / 3 filler is added only up to the leftover
  // budget. The returned length may exceed batchSize by design (guaranteed
  // coverage + filler); GSC's ~2000/day quota comfortably covers the ~50-60
  // URLs/run this produces.
  const PER_TYPE = 10;
  const guaranteed = new Set<string>();
  const addByPrefix = (prefix: string, rows: Array<{ slug: string }>) => {
    for (const r of rows) guaranteed.add(`${HOST}${prefix}${r.slug}`);
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

  // OPE-372 — events now come from the SAME gate + URL rule the sitemap uses,
  // so we never ask Google about a URL we don't publish. Previously this built
  // `/events/<slug>` straight off the events table, which for a series
  // occurrence is the legacy flat URL that 301s to the canonical nested one —
  // 48 of our open "Page with redirect" health issues were the sweep filing our
  // own working canonicalisation as a defect.
  //
  // Same JS-side ordering the vendor block below uses and for the same reason:
  // the canonical URL isn't a column, so it can't be joined on in SQL.
  const canonicalEventUrls =
    precomputedCanonicalEventUrls ??
    new Set(
      [...collectCanonicalEventPaths(await getIndexableEventRows(db))].map((p) => `${HOST}${p}`)
    );

  if (canonicalEventUrls.size > 0) {
    const inspectedEvent = await db
      .select({ url: gscInspectionState.url, last: gscInspectionState.lastInspectedAt })
      .from(gscInspectionState)
      .where(like(gscInspectionState.url, `${HOST}/events/%`));
    const lastByEventUrl = new Map(
      inspectedEvent.map((r) => [r.url, r.last ? r.last.getTime() : 0])
    );
    const eventUrls = [...canonicalEventUrls]
      .sort((a, b) => (lastByEventUrl.get(a) ?? 0) - (lastByEventUrl.get(b) ?? 0))
      .slice(0, PER_TYPE);
    for (const u of eventUrls) guaranteed.add(u);
  }

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
    for (const u of vendorUrls) guaranteed.add(u);
  }

  // Filler: Tier 1 (stale non-OK) + Tier 2/2b/2c/3 are added only up to the
  // budget left over AFTER the guaranteed per-type coverage. Anything already
  // in `guaranteed` is skipped (no double-count). When batchSize is small (the
  // default 8) this budget can be 0 — that's fine, the guaranteed set still
  // ships in full.
  const filler = new Set<string>();
  const fillerBudget = Math.max(0, batchSize - guaranteed.size);
  /** Add to filler if there's budget and it isn't already guaranteed; returns true once filler is full. */
  const addFiller = (url: string): boolean => {
    if (filler.size >= fillerBudget) return true;
    if (!guaranteed.has(url)) filler.add(url);
    return filler.size >= fillerBudget;
  };

  // Tier 0 (OPE-567 follow-up): URLs carrying an OPEN ERROR health issue.
  //
  // Tier 1 below re-inspects a non-OK *index* verdict — but `lastVerdict` only
  // stores the index half. A page that is indexed perfectly well and has BROKEN
  // STRUCTURED DATA is PASS there, so nothing ever prioritised it for a
  // re-check, and it fell into the general rotation.
  //
  // That is why the four GSC_RICH_RESULT_FAIL rows OPE-567 fixed had sat open
  // since June: all four are `PASS` / "Submitted and indexed", each with ~1,300
  // URLs ahead of it in the least-recently-inspected queue — roughly five months
  // at the default batch size. The staleness rule alone would have corrected
  // them no sooner than January.
  //
  // An open ERROR is by definition the most actionable row on the dashboard, so
  // it is the first thing worth spending an inspection on. This also makes the
  // rail self-healing: a row that is fixed or stale gets re-checked promptly and
  // downgrades itself, rather than waiting for a rotation to come around.
  /** Tier 0 picks, exempt from the canonical filter below — see the note there. */
  const openErrorUrls = new Set<string>();

  // ⚠️ CAPPED AT HALF THE FILLER BUDGET, on purpose. Uncapped, this tier owns
  // the whole sweep the moment something systemic raises a pile of ERROR rows,
  // and the tiers below it (new URLs, never-inspected pages) would never run
  // again. Priority, not monopoly.
  //
  // Scoped to GSC_RICH_RESULT_FAIL because that is the type with no other rail.
  // The OPE-382 re-verify pass above filters `issueType = GSC_INSPECTION_NON_OK`
  // and so has never once looked at a rich-result row — a second, independent
  // reason the four rows OPE-567 fixed sat open since June. Keeping the two
  // types disjoint also means the cursor write below cannot perturb re-verify's
  // ordering.
  const openErrorBudget = Math.ceil(fillerBudget / 2);
  if (openErrorBudget > 0) {
    const openErrors = await db
      .select({ id: healthIssues.id, url: healthIssues.url })
      .from(healthIssues)
      .where(
        and(
          isNull(healthIssues.resolvedAt),
          eq(healthIssues.severity, "ERROR"),
          eq(healthIssues.issueType, "GSC_RICH_RESULT_FAIL"),
          isNotNull(healthIssues.url)
        )
      )
      // Reuses OPE-382's cursor, for OPE-382's reason. Ordering by when the row
      // was DETECTED would re-pick the same oldest rows every night and starve
      // the rest — the exact head-of-line block that left two 5xx rows unfetched
      // at ranks 80 and 107. NULL sorts first in SQLite ASC, so never-attempted
      // rows lead, which is every one of them on this tier's first run.
      .orderBy(asc(healthIssues.lastReverifiedAt), asc(healthIssues.firstDetectedAt))
      .limit(openErrorBudget);

    const attempted: string[] = [];
    for (const r of openErrors) {
      if (!r.url) continue;
      if (filler.size >= openErrorBudget) break;
      attempted.push(r.id);
      openErrorUrls.add(r.url);
      if (addFiller(r.url)) break;
    }

    // Stamp EVERY row we selected, whatever the inspection later concludes — an
    // attempt must advance the cursor or the rotation above is decorative. A row
    // dropped by the canonical filter at the end of this function advances too;
    // it simply waits one rotation, which is self-correcting and far cheaper
    // than a row that can never be reached.
    // Chunked at 50, matching reverifyOpenIssues above. The list is bounded by
    // ceil(batchSize / 2), which reaches D1's 100-bound-parameter cap at
    // batchSize=200 — a value this file's own tests already pass. Local SQLite
    // allows 32,766 binds, so an unchunked version would stay green here and
    // fail only in production.
    for (let i = 0; i < attempted.length; i += 50) {
      await db
        .update(healthIssues)
        .set({ lastReverifiedAt: now })
        .where(inArray(healthIssues.id, attempted.slice(i, i + 50)));
    }
  }

  // Tier 1: URLs with non-OK last verdict
  if (fillerBudget > 0) {
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
      .limit(fillerBudget);
    for (const r of stale) if (addFiller(r.url)) break;
  }

  // Tier 2: recently-published events. OPE-372 — filtered through the canonical
  // set, so a recently-touched event that the sitemap withholds (low
  // completeness, no start date) is not inspected either.
  if (filler.size < fillerBudget) {
    const recentEvents = await db
      .select({
        slug: events.slug,
        seriesSlug: eventSeries.canonicalSlug,
        startDate: events.startDate,
      })
      .from(events)
      .leftJoin(eventSeries, eq(events.seriesId, eventSeries.id))
      .where(and(publicEventWhere(), gte(events.updatedAt, oneDayAgo)));
    for (const e of recentEvents) {
      const url = `${HOST}${canonicalEventPath(e)}`;
      if (!canonicalEventUrls.has(url)) continue;
      if (addFiller(url)) break;
    }
  }

  // Tier 2b: recently-published blog posts
  if (filler.size < fillerBudget) {
    const recentBlog = await db
      .select({ slug: blogPosts.slug })
      .from(blogPosts)
      .where(and(eq(blogPosts.status, "PUBLISHED"), gte(blogPosts.updatedAt, oneDayAgo)));
    for (const b of recentBlog) {
      if (addFiller(`${HOST}/blog/${b.slug}`)) break;
    }
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
  if (filler.size < fillerBudget) {
    const unresolvedSubmitted = await db
      .selectDistinct({ url: timeToIndexLog.url })
      .from(timeToIndexLog)
      .where(isNull(timeToIndexLog.firstCrawlAt))
      .orderBy(asc(timeToIndexLog.indexnowSubmittedAt))
      .limit(fillerBudget - filler.size);
    for (const r of unresolvedSubmitted) {
      // Only inspect our own-host URLs (the inspector resolves a path against
      // the property); a stray external URL in the log can't be inspected.
      if (r.url.startsWith(HOST) && addFiller(r.url)) break;
    }
  }

  // Tier 3: round-robin oldest. Pull from gsc_inspection_state ordered by
  // last_inspected_at ASC. Backfill from sitemap URLs if state is empty.
  if (filler.size < fillerBudget) {
    const oldest = await db
      .select({ url: gscInspectionState.url, lastInspectedAt: gscInspectionState.lastInspectedAt })
      .from(gscInspectionState)
      .orderBy(asc(gscInspectionState.lastInspectedAt))
      .limit(fillerBudget - filler.size);
    for (const o of oldest) {
      // Skip if already inspected within the cache window (6h)
      if (o.lastInspectedAt && o.lastInspectedAt.getTime() > sixHoursAgo.getTime()) continue;
      if (addFiller(o.url)) break;
    }
  }

  // Tier 3 fallback: seed from active events/venues if state is sparse.
  // OPE-372 — seed from the canonical set rather than re-deriving from slugs.
  if (filler.size < fillerBudget) {
    for (const u of canonicalEventUrls) {
      if (addFiller(u)) break;
    }
  }
  if (filler.size < fillerBudget) {
    const activeVenues = await db
      .select({ slug: venues.slug })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"))
      .limit(fillerBudget - filler.size);
    for (const v of activeVenues) {
      if (addFiller(`${HOST}/venues/${v.slug}`)) break;
    }
  }

  // OPE-372 — the choke point. Fixing the three constructors above is NOT
  // sufficient on its own: Tier 1 (stale non-OK), Tier 2c (IndexNow-submitted)
  // and Tier 3 (round-robin oldest) all read URLs back out of
  // `gsc_inspection_state` / `time_to_index_log`, which are already full of the
  // legacy flat `/events/<slug>-<year>` URLs written before this fix. Without
  // this filter those tiers would keep feeding the old URLs straight back in
  // and the queue would keep refilling — the fix would be wired into three of
  // six paths.
  //
  // Scoped to `/events/` deliberately. We have a canonical allow-list for
  // events; we do not have one for venues/promoters/blog, and silently dropping
  // those would be a different bug. Non-event URLs pass through untouched.
  const isNonCanonicalEventUrl = (u: string) =>
    u.startsWith(`${HOST}/events/`) && !canonicalEventUrls.has(u);

  // Tier 0's picks bypass the canonical filter, and ONLY Tier 0's.
  //
  // OPE-372 drops non-canonical `/events/` URLs so the discovery tiers cannot
  // keep feeding legacy flat URLs back in and refilling the queue. That reason
  // does not apply to a URL we are holding an OPEN ERROR against: we already
  // raised the row, so refusing to inspect it makes it unclosable. Measured
  // 2026-08-26 — all four open ERRORs are rich-result FAILs on flat
  // `/events/<slug>` URLs whose canonical form is `/events/<slug>/<year>`, so
  // without this exemption Tier 0 would pick them, stamp them, and then discard
  // them every single night.
  //
  // Deliberately NOT solved by widening `resolveNonCanonicalEventIssues` to
  // withdraw them: OPE-372 excluded rich-result rows from that pass on purpose
  // ("a rich-result failure is a different question and is not ours to close"),
  // and it is right — those pages serve 200 and self-canonicalise, so Google
  // indexes them and their structured data genuinely matters. Closing the row
  // would discard real signal; inspecting it cannot. Bounded and
  // self-terminating: the exemption only ever covers rows that already exist,
  // and each one disappears from it the moment the row resolves.
  const isExempt = (u: string) => openErrorUrls.has(u);
  return [...guaranteed, ...filler].filter((u) => isExempt(u) || !isNonCanonicalEventUrl(u));
}

/**
 * OPE-372 — close the health issues the old constructors manufactured.
 *
 * "Stop creating them" is only half the ticket: 81 rows were already open, and
 * a fix that leaves them there means the queue keeps misreporting. They cannot
 * self-heal through the normal path, because that path resolves an issue when a
 * later inspection comes back OK — and these URLs are now (correctly) never
 * inspected again, so their rows would sit open forever.
 *
 * Deliberately narrow, because #761 shipped a resolve loop that closed every
 * GSC issue indiscriminately and had to be fixed. Three conjunctive conditions:
 * the row is `GSC_INSPECTION_NON_OK`, its URL is under `/events/`, and that URL
 * is absent from the canonical allow-list. A genuinely-broken canonical event
 * URL stays open, as do all vendor/venue/promoter/blog rows.
 *
 * Runs each sweep rather than as a one-shot migration so it stays correct the
 * next time canonicalisation changes shape.
 */
export async function resolveNonCanonicalEventIssues(
  db: Db,
  canonicalEventUrls: Set<string>,
  now: Date
): Promise<number> {
  const open = await db
    .select({ id: healthIssues.id, url: healthIssues.url })
    .from(healthIssues)
    .where(
      and(
        eq(healthIssues.issueType, "GSC_INSPECTION_NON_OK"),
        isNull(healthIssues.resolvedAt),
        like(healthIssues.url, `${HOST}/events/%`)
      )
    );

  const stale = open.filter((r) => r.url && !canonicalEventUrls.has(r.url));
  let resolved = 0;
  for (const row of stale) {
    await db
      .update(healthIssues)
      .set({
        resolvedAt: now,
        // OPE-373 added the reason column; these are WITHDRAWN, not fixed —
        // the row should never have been raised at all.
        resolutionReason: HEALTH_RESOLUTION_REASON.WITHDRAWN,
        message: "OPE-372: withdrawn — non-canonical URL, never published in the sitemap",
      })
      .where(eq(healthIssues.id, row.id));
    resolved++;
  }
  return resolved;
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
    resolvedByReason: {},
  };

  // OPE-372 — computed once and used twice: to pick canonical URLs only, and to
  // withdraw the health issues the old non-canonical URLs manufactured.
  const canonicalEventUrls = await getCanonicalEventUrlSet(db, HOST);

  // Declared before the pick: Tier 0 stamps its cursor with this same instant,
  // so every write in the pass shares one timestamp.
  const now = new Date();

  const urls = await pickUrls(db, batchSize, canonicalEventUrls, now);

  // All three maintenance passes run BEFORE the early return: they must happen
  // even on a sweep that inspects nothing (quota exhausted, empty pick). Tying
  // cleanup to "we had work to do" is how backlogs outlive their cause — and
  // the GSC-quota case is exactly when the queue is least trustworthy.
  result.resolvedIssues += await resolveNonCanonicalEventIssues(db, canonicalEventUrls, now);

  // OPE-373 — ask our own server about the classes it can settle, then expire
  // what the scan has stopped observing. Order matters: re-verify first, so a
  // row we can prove fixed closes as `verified_fixed` rather than aging out as
  // the much weaker `no_longer_detected`.
  // Re-stamp severity first: the bucketed report groups on (message, severity),
  // and a queue where identical messages sit at different severities purely by
  // row age is not readable.
  await refreshOpenSeverities(db);
  // OPE-369 — a send recorded as stubbed was never attempted; surface it here
  // rather than by email, since email is the channel under suspicion.
  await checkStubbedSends(db, now, result);
  await reverifyOpenIssues(db, now, result);
  await expireUndetectedIssues(
    db,
    now,
    expireDaysFrom(env as unknown as { SITE_HEALTH_EXPIRE_DAYS?: string }),
    result
  );

  if (urls.length === 0) return result;

  // OPE-567 — one batched read of every inspected page's `updated_at`, before
  // the loop. A GSC verdict describes the last CRAWL; without this the sweep
  // cannot tell a live failure from one about a version of the page that
  // stopped existing two months ago. Failsoft: if the lookup throws, the map is
  // empty, every verdict is treated as current, and the sweep behaves exactly
  // as it did before this ticket.
  let pageLastChanged = new Map<string, Date>();
  try {
    pageLastChanged = await buildPageLastChangedMap(db, urls);
  } catch (error) {
    result.errors.push(
      `page-last-changed lookup failed (verdicts treated as current): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

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

      // OPE-373 — our own server outranks a stale GSC verdict for the classes
      // it can settle. A GSC verdict describes Google's LAST CRAWL: 110 open
      // rows said "Excluded by 'noindex'" for pages that serve 200 with no
      // noindex at all, because those vendors were enriched out of MENTION tier
      // after Google last looked. Without this the row is re-created on every
      // sweep — resolving them alone would refill by morning.
      const locallyDisproven =
        !isLegitimateRedirect && verdict !== "PASS" && verdict !== "SUCCESS"
          ? await (async () => {
              const outcome = await reverifyHealthIssue(url, coverage ?? verdict);
              return outcome.decidable && !outcome.stillFailing;
            })()
          : false;

      const effectivelyPassing =
        verdict === "PASS" || verdict === "SUCCESS" || isLegitimateRedirect || locallyDisproven;

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
            severity: severityForCoverage(coverage, verdict),
            url,
            message: coverage ?? verdict,
            firstDetectedAt: now,
            lastDetectedAt: now,
          });
          result.newIssues++;
        }
      } else {
        // Effectively passing — close any open issue for this URL, recording
        // WHICH of the three routes settled it (OPE-373). "Google finally said
        // PASS" and "our own server disproves Google's stale verdict" are
        // different facts and a reader needs to tell them apart.
        const reason = locallyDisproven
          ? HEALTH_RESOLUTION_REASON.VERIFIED_FIXED
          : isLegitimateRedirect
            ? HEALTH_RESOLUTION_REASON.LEGITIMATE_REDIRECT
            : HEALTH_RESOLUTION_REASON.PASSED_INSPECTION;
        const [existing] = await db
          .select()
          .from(healthIssues)
          .where(and(eq(healthIssues.fingerprint, fp), isNull(healthIssues.resolvedAt)))
          .limit(1);
        if (existing) {
          await db
            .update(healthIssues)
            .set({ resolvedAt: now, resolutionReason: reason })
            .where(eq(healthIssues.id, existing.id));
          result.resolvedIssues++;
          result.resolvedByReason = {
            ...result.resolvedByReason,
            [reason]: (result.resolvedByReason?.[reason] ?? 0) + 1,
          };
        }
      }

      // A10 — the richResults half of the SAME inspection. K46 ("Missing field
      // 'location'" on every event page, 360 GSC errors) lived here unseen for
      // two months because the sweep persisted only coverageState. A FAIL/ERROR
      // rich result becomes its own GSC_RICH_RESULT_FAIL health row (distinct
      // fingerprint from the coverage row, so the two open/resolve independently).
      const rr = summarizeRichResults(inspection.richResults, {
        lastCrawlTime: inspection.index.lastCrawlTime
          ? new Date(inspection.index.lastCrawlTime)
          : null,
        pageLastChangedAt: pageLastChanged.get(url) ?? null,
      });
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
