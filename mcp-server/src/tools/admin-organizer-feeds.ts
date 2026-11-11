/**
 * OPE-1613 — organizer feed ingestion, field provenance and pins, over MCP.
 *
 * Every writer here is operator-invoked. Since OPE-1626 the MCP Worker also
 * reads due feeds on a schedule (FEED_POLLING_ENABLED), through the same
 * `runFeedRead`; `list_promoter_feeds` / `set_promoter_feed` are its controls.
 * `ingest_promoter_feed` and `compose_feed_discrepancy_batch` default to DRY
 * RUN. No tool here sends mail: a batch is an operator draft that only goes
 * out through `review_operator_draft`, and none is composed while the feed's
 * `questions_hold` is set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { adminActions, promoterEventFeeds, promoterFeedReads, promoters } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { runFeedRead } from "../feeds/run.js";
import { checkFeedOwnership } from "../feeds/ownership.js";
import { normalizeCalendarUrl } from "../feeds/ical.js";
import { DEFAULT_POLL_HOURS } from "../feeds/fetch-feed.js";
import { parseInclusionRules } from "../feeds/inclusion.js";
import { getEventFieldProvenance } from "../feeds/provenance.js";
import { recordContactAnswer } from "../feeds/contact-answer.js";
import { composeFeedDiscrepancyBatch, feedDiscrepancyMetrics } from "../feeds/batch.js";

const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function registerOrganizerFeedTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  opts: { fetchImpl?: typeof fetch; now?: () => Date } = {}
) {
  if (auth.role !== "ADMIN") return;
  const actor = auth.userId ?? "admin";
  const now = opts.now ?? (() => new Date());

  server.tool(
    "register_promoter_feed",
    "OPE-1613 / OPE-1617 — register (or update) a promoter's own event feed. kind: 'tec_rest' = The Events Calendar WordPress REST API (site root or /wp-json/tribe/events/v1/events); 'ical' = any iCal/ICS URL (webcal:// accepted), including the public iCal address of a shared Google or Outlook/365 calendar; 'jsonld' = schema.org Event markup on an event page, a listing page (its event links are followed) or a sitemap. OWNERSHIP is checked here and refused if unproven: the feed's host must be on the promoter's domain list (OPE-1614), or — for a Google/Outlook/iCloud calendar address, whose host proves nothing — inbound_email_id must name a DMARC-passing message from a validated contact of this promoter that contains the address. inclusion_rules is JSON overriding the defaults. batch_min_interval_days is the feed-question limit per contact (default 7). poll_interval_hours is how often a scheduled read may run (default 6; the scheduler reads due feeds while FEED_POLLING_ENABLED is on). Reads nothing from the site.",
    {
      promoter_id: z.string().min(1),
      feed_url: z
        .string()
        .min(1)
        .refine((u) => {
          try {
            new URL(normalizeCalendarUrl(u));
            return true;
          } catch {
            return false;
          }
        }, "must be a URL (http, https or webcal)"),
      kind: z.enum(["tec_rest", "ical", "jsonld"]).default("tec_rest"),
      inclusion_rules: z.string().max(4000).optional(),
      batch_min_interval_days: z.number().int().min(1).max(90).default(7),
      poll_interval_hours: z.number().int().min(1).max(168).default(DEFAULT_POLL_HOURS),
      inbound_email_id: z.string().min(1).optional(),
      enabled: z.boolean().default(true),
    },
    async (p) => {
      const feedUrl = normalizeCalendarUrl(p.feed_url);
      try {
        parseInclusionRules(p.inclusion_rules);
      } catch (e) {
        return err(`inclusion_rules: ${(e as Error).message}`);
      }
      const [pr] = await db
        .select({ id: promoters.id })
        .from(promoters)
        .where(eq(promoters.id, p.promoter_id))
        .limit(1);
      if (!pr) return err("promoter not found");
      const own = await checkFeedOwnership(db, {
        promoterId: p.promoter_id,
        feedUrl,
        inboundEmailId: p.inbound_email_id ?? null,
      });
      if (!own.ok) return err(`ownership not proven: ${own.reason}`);
      const t = now();
      const [existing] = await db
        .select({ id: promoterEventFeeds.id })
        .from(promoterEventFeeds)
        .where(
          and(
            eq(promoterEventFeeds.promoterId, p.promoter_id),
            eq(promoterEventFeeds.feedUrl, feedUrl)
          )
        )
        .limit(1);
      const id = existing?.id ?? crypto.randomUUID();
      const values = {
        kind: p.kind,
        inclusionRules: p.inclusion_rules ?? null,
        batchMinIntervalDays: p.batch_min_interval_days,
        pollIntervalHours: p.poll_interval_hours,
        enabled: p.enabled,
        ownershipBasis: own.basis,
        ownershipEvidence: own.evidence,
        ownershipInboundEmailId: own.inboundEmailId,
        updatedAt: t,
      };
      if (existing) {
        await db.update(promoterEventFeeds).set(values).where(eq(promoterEventFeeds.id, id));
      } else {
        await db.insert(promoterEventFeeds).values({
          id,
          promoterId: p.promoter_id,
          feedUrl,
          createdBy: actor,
          createdAt: t,
          ...values,
        });
      }
      await db.insert(adminActions).values({
        id: crypto.randomUUID(),
        action: existing ? "feed.updated" : "feed.registered",
        actorUserId: actor,
        targetType: "promoter",
        targetId: p.promoter_id,
        payloadJson: JSON.stringify({
          feed_id: id,
          ...p,
          feed_url: feedUrl,
          ownership: { basis: own.basis, evidence: own.evidence },
        }),
        createdAt: t,
      });
      return {
        content: [
          jsonContent({
            feed_id: id,
            created: !existing,
            feed_url: feedUrl,
            ownership: { basis: own.basis, evidence: own.evidence },
          }),
        ],
      };
    }
  );

  server.tool(
    "ingest_promoter_feed",
    "OPE-1613 / OPE-1617 — read a registered feed (tec_rest, ical or jsonld) and apply it: record items, link them to events, evaluate pins, and open organizer_feed discrepancies for events we publish — including a CANCELLATION signal when the feed marks an event cancelled or a later read no longer carries it (never a silent delete or status change). The feed WRITES NO event field — every disagreement is asked of the validated contact. A real read sends the feed's stored ETag / Last-Modified, so an unchanged feed answers 304 and nothing is parsed; it also sets the feed's next scheduled read (interval, or backoff after errors). dry_run defaults to TRUE (report only, no writes, no validators sent). New feed events are marked awaiting_review, not created.",
    {
      feed_id: z.string().min(1),
      start_date: ymd.optional(),
      end_date: ymd.optional(),
      dry_run: z.boolean().default(true),
    },
    async (p) => {
      const [feed] = await db
        .select({ id: promoterEventFeeds.id, enabled: promoterEventFeeds.enabled })
        .from(promoterEventFeeds)
        .where(eq(promoterEventFeeds.id, p.feed_id))
        .limit(1);
      if (!feed) return err("feed not found");
      if (!feed.enabled) return err("feed is disabled");
      const r = await runFeedRead(db, {
        feedId: feed.id,
        now: now(),
        dryRun: p.dry_run,
        actor,
        startDate: p.start_date,
        endDate: p.end_date,
        fetchImpl: opts.fetchImpl,
      });
      if (r.outcome === "error") return err(`feed read failed: ${r.error}`);
      // The ingest report stays at the top level (the OPE-1613 shape); the
      // read's own facts sit beside it. A 304 has no report.
      const { report, ...meta } = r;
      return { content: [jsonContent({ ...(report ?? {}), ...meta })] };
    }
  );

  server.tool(
    "get_event_field_provenance",
    "OPE-1613 — for one event: each tracked field (start/end date and time, venue, status) plus every other cited field, with its current value, the authority rung of the active citation (feed / organizer_website / validated_contact / operator / extraction; 'unclassified' = a citation written before provenance existed; 'none' = uncited), the citation, and any live pin. Read-only.",
    { event_id: z.string().min(1) },
    async (p) => {
      const rows = await getEventFieldProvenance(db, p.event_id);
      if (!rows) return err("event not found");
      return { content: [jsonContent({ event_id: p.event_id, fields: rows })] };
    }
  );

  server.tool(
    "record_feed_discrepancy_answer",
    "OPE-1613 — record ONE answer from an inbound reply to ONE organizer_feed discrepancy. If the sender is a validated contact of the event's promoter AND the message passed aligned DMARC, the value is written (date/time fields; venue and status are pinned and cited for an operator to apply), cited as validated_contact, and PINNED so the feed cannot overwrite it. Otherwise the answer is staged on the discrepancy and nothing is written. Sends nothing.",
    {
      discrepancy_id: z.string().min(1),
      answer: z.string().min(1).max(500),
      inbound_email_id: z.string().min(1),
    },
    async (p) => {
      const r = await recordContactAnswer(db, {
        discrepancyId: p.discrepancy_id,
        answer: p.answer,
        inboundEmailId: p.inbound_email_id,
        actor,
        now: now(),
      });
      if (r.outcome === "refused") return err(r.reason);
      return { content: [jsonContent(r)] };
    }
  );

  server.tool(
    "compose_feed_discrepancy_batch",
    "OPE-1613 — compose ONE batched question email for a promoter's validated contact from its open organizer_feed discrepancies, into the operator draft queue (status pending; John approves via review_operator_draft). Enforces the feed's own per-contact limit (default one batch per 7 days), independent of the pre-season outreach cap. dry_run defaults to TRUE (returns the draft text, writes nothing). Sends nothing.",
    { promoter_id: z.string().min(1), dry_run: z.boolean().default(true) },
    async (p) => {
      const r = await composeFeedDiscrepancyBatch(db, {
        promoterId: p.promoter_id,
        now: now(),
        dryRun: p.dry_run,
      });
      return { content: [jsonContent(r)] };
    }
  );

  server.tool(
    "get_feed_discrepancy_metrics",
    "OPE-1613 / OPE-1511 — feed lane metrics: discrepancies raised, questions sent (in a SENT batch draft), answered, answer rate, median hours to answer, pins created, pins released because the feed was fixed, third-value changes caught, batches composed/sent. Optional promoter_id. Read-only.",
    { promoter_id: z.string().optional() },
    async (p) => ({
      content: [jsonContent(await feedDiscrepancyMetrics(db, { promoterId: p.promoter_id }))],
    })
  );

  server.tool(
    "list_promoter_feeds",
    "OPE-1626 — every registered organizer feed and its scheduled-reader state: id, promoter, url, kind, enabled, disabled_reason / disabled_at (a feed is switched off after 5 consecutive failed reads), questions_hold (while true no question batch is composed for the promoter's contact), poll interval, last_read_at / last_read_status, last_ok_at, next_read_at, consecutive_errors, and the last run's counts from the run log (outcome, trigger, http status, items read / included / linked / awaiting review, discrepancies, third values, error). Optional promoter_id. Read-only.",
    { promoter_id: z.string().min(1).optional() },
    async (p) => {
      const f = promoterEventFeeds;
      const feeds = await db
        .select({
          id: f.id,
          promoterId: f.promoterId,
          promoterName: promoters.companyName,
          feedUrl: f.feedUrl,
          kind: f.kind,
          enabled: f.enabled,
          disabledReason: f.disabledReason,
          disabledAt: f.disabledAt,
          questionsHold: f.questionsHold,
          pollIntervalHours: f.pollIntervalHours,
          lastReadAt: f.lastReadAt,
          lastReadStatus: f.lastReadStatus,
          lastOkAt: f.lastOkAt,
          nextReadAt: f.nextReadAt,
          consecutiveErrors: f.consecutiveErrors,
          pingRequestedAt: f.pingRequestedAt,
        })
        .from(f)
        .leftJoin(promoters, eq(promoters.id, f.promoterId))
        .where(p.promoter_id ? eq(f.promoterId, p.promoter_id) : undefined)
        .orderBy(asc(f.createdAt));
      // The newest run-log row per feed, in one query (no per-feed loop).
      const r = promoterFeedReads;
      const lastRuns = await db
        .select()
        .from(r)
        .where(
          sql`${r.id} = (SELECT r2.id FROM promoter_feed_reads r2 WHERE r2.feed_id = ${r.feedId} ORDER BY r2.started_at DESC, r2.id DESC LIMIT 1)`
        );
      const byFeed = new Map(lastRuns.map((x) => [x.feedId, x]));
      const iso = (d: Date | null) => d?.toISOString() ?? null;
      return {
        content: [
          jsonContent({
            feeds: feeds.map((x) => {
              const run = byFeed.get(x.id);
              return {
                id: x.id,
                promoter_id: x.promoterId,
                promoter: x.promoterName,
                url: x.feedUrl,
                kind: x.kind,
                enabled: x.enabled,
                disabled_reason: x.disabledReason,
                disabled_at: iso(x.disabledAt),
                questions_hold: x.questionsHold,
                poll_interval_hours: x.pollIntervalHours,
                last_read_at: iso(x.lastReadAt),
                last_read_status: x.lastReadStatus,
                last_ok_at: iso(x.lastOkAt),
                next_read_at: iso(x.nextReadAt),
                consecutive_errors: x.consecutiveErrors,
                ping_outstanding_since: iso(x.pingRequestedAt),
                last_run: run
                  ? {
                      started_at: iso(run.startedAt),
                      trigger: run.triggeredBy,
                      outcome: run.outcome,
                      http_status: run.httpStatus,
                      items_read: run.itemsRead,
                      included: run.included,
                      linked: run.linked,
                      awaiting_review: run.awaitingReview,
                      discrepancies: run.discrepancies,
                      third_values: run.thirdValues,
                      error: run.error,
                    }
                  : null,
              };
            }),
          }),
        ],
      };
    }
  );

  server.tool(
    "set_promoter_feed",
    "OPE-1626 — change a registered feed's scheduled-reader settings. poll_interval_hours (1–168) sets how often a scheduled read may run, from the next read on. enabled: false switches the feed off (no scheduled or manual read; reason recorded); enabled: true switches it back on, clears disabled_reason and the error streak, and makes it due at the next scheduled pass. questions_hold: true stops any question batch / operator draft being composed for the promoter's contact while reads keep opening discrepancies; false lets the next batch ask them. Audit-logged (feed.settings_changed). Sends nothing.",
    {
      feed_id: z.string().min(1),
      poll_interval_hours: z.number().int().min(1).max(168).optional(),
      enabled: z.boolean().optional(),
      questions_hold: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    },
    async (p) => {
      if (
        p.poll_interval_hours === undefined &&
        p.enabled === undefined &&
        p.questions_hold === undefined
      )
        return err("nothing to change: pass poll_interval_hours, enabled or questions_hold");
      const [feed] = await db
        .select()
        .from(promoterEventFeeds)
        .where(eq(promoterEventFeeds.id, p.feed_id))
        .limit(1);
      if (!feed) return err("feed not found");
      const t = now();
      const set: Partial<typeof promoterEventFeeds.$inferInsert> = { updatedAt: t };
      if (p.poll_interval_hours !== undefined) set.pollIntervalHours = p.poll_interval_hours;
      if (p.questions_hold !== undefined) set.questionsHold = p.questions_hold;
      if (p.enabled === true && !feed.enabled) {
        set.enabled = true;
        set.disabledReason = null;
        set.disabledAt = null;
        set.consecutiveErrors = 0;
        set.nextReadAt = null;
      } else if (p.enabled === false && feed.enabled) {
        set.enabled = false;
        set.disabledReason = `operator: ${p.reason ?? "switched off with set_promoter_feed"}`.slice(
          0,
          300
        );
        set.disabledAt = t;
      }
      await db.update(promoterEventFeeds).set(set).where(eq(promoterEventFeeds.id, feed.id));
      const before = {
        poll_interval_hours: feed.pollIntervalHours,
        enabled: feed.enabled,
        questions_hold: feed.questionsHold,
        disabled_reason: feed.disabledReason,
      };
      const [after] = await db
        .select({
          poll_interval_hours: promoterEventFeeds.pollIntervalHours,
          enabled: promoterEventFeeds.enabled,
          questions_hold: promoterEventFeeds.questionsHold,
          disabled_reason: promoterEventFeeds.disabledReason,
          next_read_at: promoterEventFeeds.nextReadAt,
        })
        .from(promoterEventFeeds)
        .where(eq(promoterEventFeeds.id, feed.id))
        .limit(1);
      await db.insert(adminActions).values({
        id: crypto.randomUUID(),
        action: "feed.settings_changed",
        actorUserId: actor,
        targetType: "promoter_event_feed",
        targetId: feed.id,
        payloadJson: JSON.stringify({ requested: p, before, after }),
        createdAt: t,
      });
      return {
        content: [
          jsonContent({
            feed_id: feed.id,
            before,
            after: { ...after, next_read_at: after.next_read_at?.toISOString() ?? null },
          }),
        ],
      };
    }
  );
}
