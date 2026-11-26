/**
 * OPE-1634 — feed analytics 3/5, the MCP half: the weekly dropped-item sample.
 *
 *   list_feed_drop_samples         — samples waiting to be filed, each with the
 *                                    ready-to-file Linear title + body. `build_now`
 *                                    builds this week's if the cron has not yet.
 *   record_feed_drop_sample_filing — stamp a sample with the OPE that carries it.
 *   label_dropped_feed_item        — the analyst's verdict on one sampled drop.
 *
 * Why an agent files the ticket: the Worker has no Linear token (OPE-76's rail,
 * src/lib/cpi/auto-file.ts). The hourly cron writes the sample row; an agent
 * session reads it here, files it with Linear `save_issue` for
 * analyst-claude-desktop, and records the OPE id. The `feed-drop-sample-filed`
 * heartbeat probe fires when a non-empty sample sits unfiled for 72h.
 *
 * Nothing here sends email. Only "should have been kept" items, or a rule that
 * looks wrong, go to John — as a comment on the sample's ticket.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import { feedDropSamples, promoterFeedItems } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import {
  DROP_SAMPLE_AGENT,
  ensureWeeklyDropSample,
  itemReason,
  listUnfiledDropSamples,
  recentDropSamples,
  recordFeedItemLabel,
  renderDropSampleIssue,
  type DropSampleItem,
} from "@takemetothefair/db-schema/feed-quality";

const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function registerFeedQualityTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  opts: { now?: () => Date } = {}
) {
  if (auth.role !== "ADMIN") return;
  const now = opts.now ?? (() => new Date());

  server.tool(
    "list_feed_drop_samples",
    `OPE-1634 — the weekly sample of organizer-feed items our inclusion rules DROPPED, for the analyst (John 2026-11-11). Returns every NON-EMPTY sample not yet filed, oldest first, each with the Linear ticket ready to file: title (routed to ${DROP_SAMPLE_AGENT}) and markdown body listing each item (title, date, URL, the rule that dropped it, the matched text). File it with Linear save_issue (team OPE, project "Personal Agent Engine", label agent-instructions, state Agent Todo), then call record_feed_drop_sample_filing. Also returns the last 8 weeks' rows (filed or empty) so a missing week is visible. build_now: build this week's sample now if the hourly cron has not (idempotent; one row per week). Read-only unless build_now.`,
    { build_now: z.boolean().default(false) },
    async (p) => {
      const built = p.build_now ? await ensureWeeklyDropSample(db, now()) : null;
      const unfiled = await listUnfiledDropSamples(db);
      const recent = await recentDropSamples(db);
      return {
        content: [
          jsonContent({
            built,
            to_file: unfiled.map((s) => ({
              sample_id: s.id,
              week_start: s.weekStart,
              items: s.itemCount,
              dropped_total: s.droppedTotal,
              ticket: renderDropSampleIssue(s),
            })),
            recent: recent.map((s) => ({
              sample_id: s.id,
              week_start: s.weekStart,
              items: s.itemCount,
              dropped_total: s.droppedTotal,
              ope_id: s.opeId,
              filed_at: s.filedAt ? s.filedAt.toISOString() : null,
            })),
          }),
        ],
      };
    }
  );

  server.tool(
    "record_feed_drop_sample_filing",
    "OPE-1634 — record the OPE issue that carries a weekly feed drop sample (after filing it from list_feed_drop_samples), so it stops being listed as to-file and the feed-drop-sample-filed probe clears. Refuses to overwrite a DIFFERENT ope_id (two tickets would be about to collide); re-recording the same one is a no-op.",
    {
      sample_id: z.string().min(1),
      ope_id: z.string().regex(/^OPE-\d+$/, "an OPE identifier, e.g. OPE-1712"),
    },
    async (p) => {
      const [s] = await db
        .select({ id: feedDropSamples.id, opeId: feedDropSamples.opeId })
        .from(feedDropSamples)
        .where(eq(feedDropSamples.id, p.sample_id))
        .limit(1);
      if (!s) return err(`no feed drop sample ${p.sample_id}`);
      if (s.opeId && s.opeId !== p.ope_id)
        return err(
          `sample ${p.sample_id} is already filed as ${s.opeId}; not overwriting it with ${p.ope_id}.`
        );
      if (s.opeId === p.ope_id)
        return {
          content: [jsonContent({ ok: true, sample_id: s.id, ope_id: s.opeId, changed: false })],
        };
      await db
        .update(feedDropSamples)
        .set({ opeId: p.ope_id, filedAt: now() })
        .where(eq(feedDropSamples.id, p.sample_id));
      return {
        content: [jsonContent({ ok: true, sample_id: s.id, ope_id: p.ope_id, changed: true })],
      };
    }
  );

  server.tool(
    "label_dropped_feed_item",
    "OPE-1634 — the analyst's verdict on ONE dropped organizer-feed item from a weekly drop sample: 'correct_drop' (we were right not to list it) or 'should_have_been_kept' (a public event we would list — note REQUIRED, one line saying why). Recorded as a feed_item_labels row against the rule that dropped the item; a 'should_have_been_kept' counts as a FALSE DROP for that rule in get_feed_lane_metrics.quality.false_drops. Changes nothing about the item itself (it is not listed or re-queued) — if it should be listed, say so to John on the sample's ticket. Re-labelling an item adds a new label; the newest one is the verdict. Sends nothing.",
    {
      feed_item_id: z.string().min(1),
      verdict: z.enum(["correct_drop", "should_have_been_kept"]),
      sample_id: z.string().min(1).optional().describe("The drop sample the item came from."),
      note: z
        .string()
        .max(1000)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("REQUIRED for should_have_been_kept: why it should have been listed."),
    },
    async (p) => {
      if (p.verdict === "should_have_been_kept" && !p.note?.trim())
        return err("should_have_been_kept needs a note: why it should have been listed.");
      const [item] = await db
        .select()
        .from(promoterFeedItems)
        .where(eq(promoterFeedItems.id, p.feed_item_id))
        .limit(1);
      if (!item) return err(`no feed item ${p.feed_item_id}`);
      // Label against the rule the SAMPLE showed when there is one: a rule
      // tuned since the sample was built must not move the label to another rule.
      let reason = itemReason(item);
      if (p.sample_id) {
        const [s] = await db
          .select({ items: feedDropSamples.items })
          .from(feedDropSamples)
          .where(eq(feedDropSamples.id, p.sample_id))
          .limit(1);
        if (!s) return err(`no feed drop sample ${p.sample_id}`);
        const inSample = (JSON.parse(s.items) as DropSampleItem[]).find(
          (i) => i.itemId === item.id
        );
        if (!inSample) return err(`item ${item.id} is not in sample ${p.sample_id}`);
        reason = inSample.reason ?? reason;
      }
      const warnings: string[] = [];
      if (item.reviewState !== "dropped")
        warnings.push(
          `the item is now '${item.reviewState}', not dropped (a rule or a reviewer changed it since); the label is recorded against the rule that dropped it.`
        );
      const id = await recordFeedItemLabel(db, {
        feedItemId: item.id,
        feedId: item.feedId,
        label: p.verdict === "correct_drop" ? "correct_drop" : "false_drop",
        reason,
        included: false,
        source: "analyst",
        actor: auth.userId ?? "analyst",
        note: p.note ?? null,
        sampleId: p.sample_id ?? null,
        at: now(),
      });
      return {
        content: [
          jsonContent({
            ok: true,
            label_id: id,
            feed_item_id: item.id,
            label: p.verdict === "correct_drop" ? "correct_drop" : "false_drop",
            ...(warnings.length ? { warnings } : {}),
          }),
        ],
      };
    }
  );
}
