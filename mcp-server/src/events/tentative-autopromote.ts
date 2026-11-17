/**
 * OPE-1586 — the TENTATIVE → SCHEDULED rule, on John's ruling of 2026-11-16
 * (option 2): promote only when a FRESH read of the cited organizer page agrees.
 *
 * Every weekend digest and every SCHEDULED-filtered feed drops TENTATIVE rows,
 * and promotion was hand-only, so `ready` events vanished from the digest in the
 * busiest holiday-fair stretch (26 within 14 days on 11-08; 49 within 21 days on
 * 11-16). `tentative-queue.ts` already ranks the candidates; it was built as a
 * reader because promotion was STOP-gated (OPE-611 §4). This is the writer that
 * gate was waiting on, and it is narrower than `ready` on purpose — see
 * page-date-agreement.ts for why `ready` alone is not enough.
 *
 * Three passes, each failsoft per row:
 *
 *  1. PROMOTE. `ready` rows starting within PROMOTE_WITHIN_DAYS that a human has
 *     not checked-and-held recently and that this rule has not already reversed.
 *     Re-fetch each active official_website citation on start_date; the first
 *     page that agrees promotes, writing the same `event.lifecycle_change`
 *     audit row update_event_lifecycle writes (so get_event_lifecycle_history
 *     shows it), naming the rule, the URL and the text matched.
 *  2. HOLD. Everything else stays TENTATIVE. Its reason (fetch failed, date
 *     absent, hedged, …) is recorded in the run row — NOT as a lifecycle check,
 *     because a check stamp removes a row from the operator digest for 14 days,
 *     and John's ruling is that an unconfirmed row STAYS in the digest.
 *  3. REVERSE. Upcoming rows this rule promoted (and nobody has transitioned
 *     since) are re-read. A page that now disagrees demotes the row to
 *     TENTATIVE and raises the `auto_promotion_reversed` review flag. A fetch
 *     that FAILS is not a contradiction — a flaky host must not demote.
 *
 * One `event.tentative_autopromote_run` admin_actions row per run carries the
 * summary; the operator digest reads it and prints one line. This module
 * never sends anything itself.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { raiseEventReviewFlag } from "@takemetothefair/db-schema";
import { chunkIds } from "@takemetothefair/utils";
import type { BrowserRenderingEnv } from "@takemetothefair/site-fetch";
import { adminActions, agentHeartbeats, eventDataCitations, events } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";
import { fetchVendorSite, type SiteFetchResult } from "../enrichment/fetch-site.js";
import { readTentativePromotionQueue, SELF_HOST } from "./tentative-queue.js";
import { pageAgreesWithStartDate, type DisagreeReason } from "./page-date-agreement.js";

/** The ticket's window: an event starting within 21 days. */
export const PROMOTE_WITHIN_DAYS = 21;
/** Per-run caps — each candidate is up to two page fetches. */
export const PROMOTE_LIMIT = 60;
export const RECHECK_LIMIT = 60;
/** Citation URLs tried per event before holding it. */
const MAX_URLS_PER_EVENT = 2;
const FETCH_CONCURRENCY = 4;

export const AUTOPROMOTE_VIA = "tentative-autopromote";
export const AUTOPROMOTE_RUN_ACTION = "event.tentative_autopromote_run";
export const AUTOPROMOTE_HEARTBEAT_CODE = "watchdog:tentative-autopromote";
const SOURCE = "mcp/tentative-autopromote";

export type HoldReason = DisagreeReason | "fetch_failed" | "no_citation_url";

export interface AutopromoteResult {
  examined: number;
  promoted: { slug: string; url: string; matched: string }[];
  held: { slug: string; reason: HoldReason; detail?: string }[];
  rechecked: number;
  demoted: { slug: string; reason: HoldReason; detail?: string }[];
  errors: number;
  summary: string;
}

export type PageFetcher = (url: string) => Promise<SiteFetchResult>;

export interface AutopromoteOptions {
  now?: Date;
  /** Injected in tests; defaults to the shared SSRF-guarded fetch with Browser-Rendering escalation. */
  fetchPage?: PageFetcher;
  env?: BrowserRenderingEnv;
}

type Verdict =
  | { agrees: true; url: string; matched: string }
  | { agrees: false; reason: HoldReason; detail?: string; fetched: boolean };

async function checkUrls(urls: string[], start: Date, fetchPage: PageFetcher): Promise<Verdict> {
  if (urls.length === 0) return { agrees: false, reason: "no_citation_url", fetched: false };
  let last: Verdict = { agrees: false, reason: "fetch_failed", fetched: false };
  for (const url of urls.slice(0, MAX_URLS_PER_EVENT)) {
    let page: SiteFetchResult;
    try {
      page = await fetchPage(url);
    } catch (error) {
      page = { ok: false, html: null, fetchMethod: "failed", failReason: String(error) };
    }
    if (!page.ok || page.html == null) {
      // Keep a fetched verdict from an earlier URL over a later fetch failure.
      if (!(!last.agrees && last.fetched)) {
        last = {
          agrees: false,
          reason: "fetch_failed",
          detail: page.failReason?.slice(0, 120),
          fetched: false,
        };
      }
      continue;
    }
    const v = pageAgreesWithStartDate(page.html, start);
    if (v.agrees) return { agrees: true, url, matched: v.matched };
    last = { agrees: false, reason: v.reason, detail: v.detail, fetched: true };
  }
  return last;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const t = items[i++];
      await fn(t);
    }
  });
  await Promise.all(workers);
}

/** Count reasons as "date_absent ×3, fetch_failed ×1". */
function reasonTally(rows: { reason: HoldReason }[]): string {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.reason, (m.get(r.reason) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ");
}

export function summarize(r: Omit<AutopromoteResult, "summary">): string {
  const held = r.held.length;
  return (
    `auto-promoted ${r.promoted.length}; ${held} left for review` +
    (held > 0 ? ` (${reasonTally(r.held)})` : "") +
    (r.demoted.length > 0 ? `; demoted ${r.demoted.length} on a disagreeing re-read` : "") +
    (r.errors > 0 ? `; ${r.errors} error(s)` : "")
  );
}

export async function runTentativeAutopromote(
  db: Db,
  opts: AutopromoteOptions = {}
): Promise<AutopromoteResult> {
  const now = opts.now ?? new Date();
  const nowSecs = Math.floor(now.getTime() / 1000);
  const fetchPage: PageFetcher = opts.fetchPage ?? ((url) => fetchVendorSite(url, opts.env ?? {}));
  const result: Omit<AutopromoteResult, "summary"> = {
    examined: 0,
    promoted: [],
    held: [],
    rechecked: 0,
    demoted: [],
    errors: 0,
  };

  // ── Pass 1 + 2: promote or hold ───────────────────────────────────────────
  try {
    const queue = await readTentativePromotionQueue(db, now, {
      withinSeconds: PROMOTE_WITHIN_DAYS * 86400,
      limit: 500,
    });
    let candidates = queue.filter((r) => r.tier === "ready" && !r.recentlyChecked);

    // A row this rule already reversed waits for a person (the review flag).
    if (candidates.length > 0) {
      const reversed = new Set<string>();
      for (const ids of chunkIds(candidates.map((c) => c.id))) {
        const rows = await db.all<{ event_id: string }>(sql`
          SELECT event_id FROM event_review_flags
           WHERE reason = 'auto_promotion_reversed' AND cleared_at IS NULL
             AND event_id IN (${sql.join(
               ids.map((id) => sql`${id}`),
               sql`, `
             )})`);
        for (const r of rows) reversed.add(r.event_id);
      }
      candidates = candidates.filter((c) => !reversed.has(c.id)).slice(0, PROMOTE_LIMIT);
    }

    // The URLs the `ready` tier counted: active official_website on start_date, not our host.
    const urlsByEvent = new Map<string, string[]>();
    for (const ids of chunkIds(candidates.map((c) => c.id))) {
      if (ids.length === 0) continue;
      const rows = await db
        .select({ eventId: eventDataCitations.eventId, url: eventDataCitations.sourceUrl })
        .from(eventDataCitations)
        .where(
          and(
            inArray(eventDataCitations.eventId, ids),
            eq(eventDataCitations.state, "active"),
            eq(eventDataCitations.sourceType, "official_website"),
            eq(eventDataCitations.fieldName, "start_date"),
            sql`instr(lower(${eventDataCitations.sourceUrl}), ${SELF_HOST}) = 0`
          )
        )
        .orderBy(sql`${eventDataCitations.updatedAt} DESC`);
      for (const r of rows) {
        if (!r.url) continue;
        const list = urlsByEvent.get(r.eventId) ?? [];
        if (!list.includes(r.url)) list.push(r.url);
        urlsByEvent.set(r.eventId, list);
      }
    }

    result.examined = candidates.length;
    await pool(candidates, FETCH_CONCURRENCY, async (c) => {
      try {
        if (!c.startDate) return;
        const v = await checkUrls(urlsByEvent.get(c.id) ?? [], c.startDate, fetchPage);
        if (!v.agrees) {
          result.held.push({ slug: c.slug, reason: v.reason, detail: v.detail });
          return;
        }
        const reason = `auto (OPE-1586): organizer page agrees — "${v.matched}" at ${v.url}`.slice(
          0,
          500
        );
        // Guarded on lifecycle_status so a person who moved the row while the
        // fetch was in flight wins; the audit row is written only on a change.
        const updated = await db
          .update(events)
          .set({
            lifecycleStatus: "SCHEDULED",
            lifecycleStatusChangedAt: now,
            lifecycleReason: reason,
            lifecycleLastCheckedAt: now,
            lifecycleCheckNote: reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(events.id, c.id),
              eq(events.lifecycleStatus, "TENTATIVE"),
              isNull(events.mergedInto)
            )
          )
          .returning({ id: events.id });
        if (updated.length === 0) return;
        await db.insert(adminActions).values({
          action: "event.lifecycle_change",
          actorUserId: null,
          targetType: "event",
          targetId: c.id,
          payloadJson: JSON.stringify({
            previous_lifecycle: "TENTATIVE",
            new_lifecycle: "SCHEDULED",
            reason,
            slug: c.slug,
            via: AUTOPROMOTE_VIA,
            rule: "OPE-1586",
            matched_url: v.url,
            matched_text: v.matched,
          }),
          createdAt: now,
        });
        result.promoted.push({ slug: c.slug, url: v.url, matched: v.matched });
      } catch (error) {
        result.errors++;
        await logError(db, {
          source: SOURCE,
          message: `[tentative-autopromote] promote failed for ${c.slug}`,
          error,
        });
      }
    });
  } catch (error) {
    result.errors++;
    await logError(db, {
      source: SOURCE,
      message: "[tentative-autopromote] promote pass failed",
      error,
    });
  }

  // ── Pass 3: re-read what this rule promoted; demote on contradiction ──────
  try {
    const promotedNow = new Set(result.promoted.map((p) => p.slug));
    const rows = await db.all<{
      id: string;
      slug: string;
      start_date: number;
      matched_url: string | null;
    }>(sql`
      -- Correlated on idx_admin_actions_target (target_type, target_id), run
      -- only for the upcoming SCHEDULED window — not a window function over the
      -- whole audit table (D1 bills rows read; OPE-1573).
      SELECT e.id, e.slug, e.start_date,
             (SELECT json_extract(a.payload_json, '$.matched_url') FROM admin_actions a
               WHERE a.target_type = 'event' AND a.target_id = e.id
                 AND a.action = 'event.lifecycle_change'
               ORDER BY a.created_at DESC LIMIT 1) AS matched_url
        FROM events e
       WHERE e.lifecycle_status = 'SCHEDULED'
         AND e.merged_into IS NULL
         AND e.start_date >= ${nowSecs}
         AND e.start_date <= ${nowSecs + PROMOTE_WITHIN_DAYS * 86400}
         AND (SELECT json_extract(a.payload_json, '$.via') FROM admin_actions a
               WHERE a.target_type = 'event' AND a.target_id = e.id
                 AND a.action = 'event.lifecycle_change'
               ORDER BY a.created_at DESC LIMIT 1) = ${AUTOPROMOTE_VIA}
       ORDER BY e.start_date ASC
       LIMIT ${RECHECK_LIMIT}`);
    const toCheck = rows.filter((r) => !promotedNow.has(r.slug) && r.matched_url);
    result.rechecked = toCheck.length;
    await pool(toCheck, FETCH_CONCURRENCY, async (r) => {
      try {
        const v = await checkUrls(
          [r.matched_url!],
          new Date(Number(r.start_date) * 1000),
          fetchPage
        );
        // Only a page we READ and that now disagrees is a contradiction.
        // `no_text` is a render flake as often as a change, so it is not one either.
        if (v.agrees || !v.fetched || v.reason === "no_text") return;
        const reason =
          `auto (OPE-1586): demoted — organizer page no longer agrees (${v.reason}` +
          `${v.detail ? `: ${v.detail}` : ""}) at ${r.matched_url}`;
        const updated = await db
          .update(events)
          .set({
            lifecycleStatus: "TENTATIVE",
            lifecycleStatusChangedAt: now,
            lifecycleReason: reason.slice(0, 500),
            updatedAt: now,
          })
          .where(and(eq(events.id, r.id), eq(events.lifecycleStatus, "SCHEDULED")))
          .returning({ id: events.id });
        if (updated.length === 0) return;
        await db.insert(adminActions).values({
          action: "event.lifecycle_change",
          actorUserId: null,
          targetType: "event",
          targetId: r.id,
          payloadJson: JSON.stringify({
            previous_lifecycle: "SCHEDULED",
            new_lifecycle: "TENTATIVE",
            reason: reason.slice(0, 500),
            slug: r.slug,
            via: `${AUTOPROMOTE_VIA}:reversal`,
            rule: "OPE-1586",
            matched_url: r.matched_url,
          }),
          createdAt: now,
        });
        await raiseEventReviewFlag(db, r.id, "auto_promotion_reversed", AUTOPROMOTE_VIA);
        result.demoted.push({ slug: r.slug, reason: v.reason, detail: v.detail });
      } catch (error) {
        result.errors++;
        await logError(db, {
          source: SOURCE,
          message: `[tentative-autopromote] reversal failed for ${r.slug}`,
          error,
        });
      }
    });
  } catch (error) {
    result.errors++;
    await logError(db, {
      source: SOURCE,
      message: "[tentative-autopromote] reversal pass failed",
      error,
    });
  }

  const summary = summarize(result);
  const full: AutopromoteResult = { ...result, summary };

  // The run row the digest reads, and the heartbeat the OPE-246 probe watches.
  // Both on every run, including a run that promoted nothing.
  try {
    await db.insert(adminActions).values({
      action: AUTOPROMOTE_RUN_ACTION,
      actorUserId: null,
      targetType: "system",
      targetId: AUTOPROMOTE_VIA,
      payloadJson: JSON.stringify({
        summary,
        examined: full.examined,
        promoted: full.promoted.map((p) => p.slug),
        held: full.held,
        rechecked: full.rechecked,
        demoted: full.demoted,
        errors: full.errors,
      }),
      createdAt: now,
    });
    const note = `examined=${full.examined} promoted=${full.promoted.length} held=${full.held.length} demoted=${full.demoted.length} errors=${full.errors}`;
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: AUTOPROMOTE_HEARTBEAT_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "[tentative-autopromote] run record failed",
      error,
    });
  }

  console.log(`[cron] tentative-autopromote — ${summary}`);
  return full;
}

/** The newest run row within `withinHours`, for the operator digest. */
export async function readLatestAutopromoteRun(
  db: Db,
  now: Date,
  withinHours = 26
): Promise<{
  summary: string;
  held: { slug: string; reason: string; detail?: string }[];
  createdAt: Date;
} | null> {
  const since = new Date(now.getTime() - withinHours * 3600_000);
  const [row] = await db
    .select({ payload: adminActions.payloadJson, createdAt: adminActions.createdAt })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, AUTOPROMOTE_RUN_ACTION),
        sql`${adminActions.createdAt} >= ${Math.floor(since.getTime() / 1000)}`
      )
    )
    .orderBy(sql`${adminActions.createdAt} DESC`)
    .limit(1);
  if (!row?.payload) return null;
  try {
    const p = JSON.parse(row.payload) as {
      summary?: string;
      held?: { slug: string; reason: string; detail?: string }[];
    };
    return { summary: p.summary ?? "", held: p.held ?? [], createdAt: row.createdAt };
  } catch {
    return null;
  }
}
