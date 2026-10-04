/**
 * OPE-1280 — `url_health_checks` gets a reader an operator actually sees.
 *
 * OPE-860 made the table; OPE-868 filled it daily for `promoters.website`
 * (14,091 checks by 2026-10-02) and gave it a JSON `GET` nobody's UI calls. 311
 * distinct promoter websites read non-green, among them one `domain_takeover`
 * and one `closure_notice`, and the site-health queue carried none of them.
 *
 * This projects each fresh verdict into `health_issues` (the queue the admin
 * Site Health tab renders), as source `URL_HEALTH`. It is called once per
 * check by whichever sweep made the check, and it is keyed on `source_field`,
 * never on which sweep called it — so OPE-1270's vendor sweep inherits it by
 * passing `"vendors.website"`, with no second code path.
 *
 * ## Which verdicts become rows, and why (the sizing)
 *
 * | verdict           | severity | rows today (promoters) |
 * |-------------------|----------|------------------------|
 * | `domain_takeover` | ERROR    | 1                      |
 * | `closure_notice`  | ERROR    | 1                      |
 * | `http_error`      | WARNING  | 127                    |
 * | `unreachable`     | WARNING  | 49                     |
 * | `no_event_signal` | —        | 134, NOT projected     |
 *
 * ERROR for the two verdicts that mean a visitor we send there lands somewhere
 * WRONG (another owner's content; an organizer saying it has stopped). WARNING
 * for the two that mean the link is broken, which is often transient and the
 * sweep re-checks daily.
 *
 * `no_event_signal` is deliberately not projected. A real organizer site that
 * renders its dates in an image reads it too (the asymmetry documented in
 * url-health.ts), so one queue row per URL would be 134 rows of mostly
 * false alarms today and ~11× that once vendors are swept. Its drill-down is
 * the existing `GET /api/admin/url-health/promoters/sweep`. Nothing here, for
 * any verdict, writes to the entity or unpublishes anything.
 *
 * Cost to the site-health sweep (OPE-382): none from re-verify, which selects
 * `GSC_INSPECTION_NON_OK` only; `refreshOpenSeverities` is scoped to GSC rows
 * in the same change, so these rows add no per-run work there either.
 *
 * ## Resolve discipline (OPE-373)
 *
 * The sweep re-checks every URL daily, so every check is evidence either way:
 *  - a projected verdict opens (or re-opens, or refreshes) its row;
 *  - every OTHER open URL_HEALTH row for the same (source_field, url) closes —
 *    `verified_fixed` when the URL now reads `ok`, `superseded` when it now reads
 *    a different non-green verdict (the old condition is gone; a new one, or an
 *    unprojected one, replaced it).
 * A URL that stops being swept is never resolved here; the generic 21-day
 * expiry closes it as `no_longer_detected`, which is the honest reason.
 *
 * ## Freshness (OPE-567)
 *
 * `last_detected_at` is the check's own `checked_at`, and the message names the
 * date, so a row always says when it was last confirmed.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { healthIssues, HEALTH_RESOLUTION_REASON } from "@/lib/db/schema";
import { fingerprintFor } from "@/lib/site-health";

type Db = DrizzleD1Database<typeof schema>;

export const URL_HEALTH_SOURCE = "URL_HEALTH" as const;

/** The verdicts that become queue rows, with their severity. */
export const PROJECTED_URL_HEALTH: Readonly<Record<string, "ERROR" | "WARNING">> = {
  domain_takeover: "ERROR",
  closure_notice: "ERROR",
  http_error: "WARNING",
  unreachable: "WARNING",
  // OPE-1270 — vendor-site verdict (vendor-site-health.ts). A promoter sweep
  // never emits it, so it costs that source nothing.
  moved: "WARNING",
  // ⚠️ `empty_page` is deliberately NOT projected (OPE-1281 measurement,
  // 2026-10-02): 58 of 127 promoter `no_event_signal` URLs are in the same
  // near-empty branch, and spot-checked live ones (durhamfair.com, osv.org,
  // waterfire.org, deerfieldfair.com) serve 45–326 KB to a normal client — the
  // sweep runs from a Worker and gets a bot wall. Near-empty from a Worker is
  // "could not see the page", not "the site is parked"; projecting it would
  // fill the queue with live sites. It stays recorded in url_health_checks.
};

const PHRASE: Record<string, string> = {
  domain_takeover: "now serves someone else's content (domain takeover)",
  closure_notice: "announces a closure or handover",
  http_error: "returns an HTTP error",
  unreachable: "did not respond",
  moved: "redirects to a different domain",
};

/** `URL_HEALTH_HTTP_ERROR` etc. One issue type per verdict class. */
export function urlHealthIssueType(verdict: string): string {
  return `URL_HEALTH_${verdict.toUpperCase()}`;
}

/**
 * The fingerprint keys on (source_field, url, verdict). source_field rides in
 * the issue-type slot of the shared hash so the same URL stored on a promoter
 * AND on a vendor is two facts about two records, not one row.
 */
export function urlHealthFingerprint(
  sourceField: string,
  url: string,
  verdict: string
): Promise<string> {
  return fingerprintFor(URL_HEALTH_SOURCE, `${urlHealthIssueType(verdict)}@${sourceField}`, url);
}

/**
 * The operator-facing message. Constant per (source_field, verdict) apart from
 * digits — the Site Health tab groups on `source|issue_type|message` with digit
 * runs folded, so every URL with one verdict lands in one group while each row
 * still states its HTTP status and the date it was last checked.
 */
export function urlHealthMessage(
  sourceField: string,
  verdict: string,
  httpStatus: number | null,
  checkedAt: Date
): string {
  const status = httpStatus === null ? "no response" : `HTTP ${httpStatus}`;
  return `${sourceField} ${PHRASE[verdict] ?? verdict} · ${status} · last checked ${checkedAt
    .toISOString()
    .slice(0, 10)}`;
}

export interface UrlHealthProjection {
  opened: number;
  reopened: number;
  refreshed: number;
  resolved: number;
}

export async function projectUrlHealthVerdict(
  db: Db,
  check: {
    sourceField: string;
    url: string;
    verdict: string;
    httpStatus: number | null;
    checkedAt: Date;
  }
): Promise<UrlHealthProjection> {
  const out: UrlHealthProjection = { opened: 0, reopened: 0, refreshed: 0, resolved: 0 };
  const { sourceField, url, verdict, httpStatus, checkedAt } = check;

  // Every projected verdict's fingerprint for THIS (source_field, url). Four
  // values, one indexed IN — the unique fingerprint index does the work.
  const fps = await Promise.all(
    Object.keys(PROJECTED_URL_HEALTH).map(async (v) => ({
      verdict: v,
      fp: await urlHealthFingerprint(sourceField, url, v),
    }))
  );
  const rows = await db
    .select()
    .from(healthIssues)
    .where(
      inArray(
        healthIssues.fingerprint,
        fps.map((f) => f.fp)
      )
    );
  const byFp = new Map(rows.map((r) => [r.fingerprint, r]));

  const severity = PROJECTED_URL_HEALTH[verdict];
  const currentFp = severity ? fps.find((f) => f.verdict === verdict)!.fp : null;

  // Close every OTHER open row for this URL first: the check we just made
  // disproves them.
  for (const f of fps) {
    if (f.fp === currentFp) continue;
    const row = byFp.get(f.fp);
    if (!row || row.resolvedAt) continue;
    await db
      .update(healthIssues)
      .set({
        resolvedAt: checkedAt,
        resolutionReason:
          verdict === "ok"
            ? HEALTH_RESOLUTION_REASON.VERIFIED_FIXED
            : HEALTH_RESOLUTION_REASON.SUPERSEDED,
        message: `${row.message} — resolved: now reads ${verdict} (${checkedAt
          .toISOString()
          .slice(0, 10)})`,
      })
      .where(and(eq(healthIssues.id, row.id), isNull(healthIssues.resolvedAt)));
    out.resolved++;
  }

  if (!currentFp || !severity) return out;

  const message = urlHealthMessage(sourceField, verdict, httpStatus, checkedAt);
  const existing = byFp.get(currentFp);
  if (!existing) {
    await db.insert(healthIssues).values({
      fingerprint: currentFp,
      source: URL_HEALTH_SOURCE,
      issueType: urlHealthIssueType(verdict),
      severity,
      url,
      message,
      firstDetectedAt: checkedAt,
      lastDetectedAt: checkedAt,
    });
    out.opened++;
  } else if (existing.resolvedAt) {
    await db
      .update(healthIssues)
      .set({
        resolvedAt: null,
        resolutionReason: null,
        lastDetectedAt: checkedAt,
        severity,
        message,
      })
      .where(eq(healthIssues.id, existing.id));
    out.reopened++;
  } else {
    await db
      .update(healthIssues)
      .set({ lastDetectedAt: checkedAt, severity, message })
      .where(eq(healthIssues.id, existing.id));
    out.refreshed++;
  }
  return out;
}

/**
 * OPE-1270 — a FLAG is a fact about the URL that is independent of its health
 * verdict: today only `name_drift` (the site's own JSON-LD names the business
 * differently from our record). It has its own fingerprint family, so a
 * healthy `ok` re-check does not close it — only a re-check that can SEE the
 * site's name and finds it matching does.
 *
 *   present === true  → open / re-open / refresh
 *   present === false → close as verified_fixed (we read the name; it matches)
 *   present === null  → nothing: the site declared no name this time, and an
 *                       absent declaration is not evidence the name matches
 *
 * INFO severity: it is a review prompt (should our record be renamed?), never
 * an outage, and a rename is a deliberate operator act through update_vendor —
 * this surface has no apply button by design (OPE-1270's STOP).
 */
export const URL_HEALTH_FLAGS: Readonly<Record<string, { severity: string; phrase: string }>> = {
  name_drift: { severity: "INFO", phrase: "names the business differently from our record" },
};

export async function projectUrlHealthFlag(
  db: Db,
  check: {
    sourceField: string;
    url: string;
    flag: string;
    present: boolean | null;
    checkedAt: Date;
    /**
     * OPE-1270 (rework) — the evidence, shown in the row so it can be triaged
     * from the queue: e.g. `ours "Bay State Savings Bank" · site "Bay State
     * Bank"`. Without it 138 open rows said only "names the business
     * differently". Each name is QUOTED: the Site Health grouping key folds
     * quoted spans (like digit runs), so the evidence shows per row without
     * splitting the group.
     */
    evidence?: string | null;
  }
): Promise<UrlHealthProjection> {
  const out: UrlHealthProjection = { opened: 0, reopened: 0, refreshed: 0, resolved: 0 };
  const def = URL_HEALTH_FLAGS[check.flag];
  if (!def || check.present === null) return out;

  const fp = await urlHealthFingerprint(check.sourceField, check.url, check.flag);
  const [existing] = await db
    .select()
    .from(healthIssues)
    .where(eq(healthIssues.fingerprint, fp))
    .limit(1);
  const day = check.checkedAt.toISOString().slice(0, 10);

  if (!check.present) {
    if (existing && !existing.resolvedAt) {
      await db
        .update(healthIssues)
        .set({
          resolvedAt: check.checkedAt,
          resolutionReason: HEALTH_RESOLUTION_REASON.VERIFIED_FIXED,
          message: `${existing.message} — resolved: names match (${day})`,
        })
        .where(and(eq(healthIssues.id, existing.id), isNull(healthIssues.resolvedAt)));
      out.resolved++;
    }
    return out;
  }

  const message = `${check.sourceField} ${def.phrase}${
    check.evidence ? ` · ${check.evidence}` : ""
  } · last checked ${day}`;
  if (!existing) {
    await db.insert(healthIssues).values({
      fingerprint: fp,
      source: URL_HEALTH_SOURCE,
      issueType: urlHealthIssueType(check.flag),
      severity: def.severity,
      url: check.url,
      message,
      firstDetectedAt: check.checkedAt,
      lastDetectedAt: check.checkedAt,
    });
    out.opened++;
  } else if (existing.resolvedAt) {
    await db
      .update(healthIssues)
      .set({ resolvedAt: null, resolutionReason: null, lastDetectedAt: check.checkedAt, message })
      .where(eq(healthIssues.id, existing.id));
    out.reopened++;
  } else {
    await db
      .update(healthIssues)
      .set({ lastDetectedAt: check.checkedAt, message })
      .where(eq(healthIssues.id, existing.id));
    out.refreshed++;
  }
  return out;
}
