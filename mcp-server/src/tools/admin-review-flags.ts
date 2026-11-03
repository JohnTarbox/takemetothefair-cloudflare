/**
 * OPE-767 — WHY an event is flagged, and the audited way a person discharges a
 * reason (John, 2026-09-30: option A).
 *
 * `missing_hours` clears itself when the hours are filled in. Every other
 * reason is a judgement — confirm a rollover's predicted dates, check a former
 * venue, review a past-dated import — and is discharged here, one reason at a
 * time, with an admin_actions row. `legacy` (flagged before reasons were
 * recorded) is cleared the same way, after a look.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import {
  adminActions,
  events,
  eventReviewFlags,
  clearEventReviewFlag,
  EVENT_REVIEW_FLAG_REASONS,
} from "../schema.js";
import { jsonContent, decodeHtmlEntities } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

async function flagState(db: Db, eventId: string) {
  const [ev] = await db
    .select({ id: events.id, slug: events.slug, flagged: events.flaggedForReview })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) return null;
  const rows = await db
    .select()
    .from(eventReviewFlags)
    .where(eq(eventReviewFlags.eventId, eventId))
    .orderBy(asc(eventReviewFlags.raisedAt));
  const toSec = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
  return {
    event_id: ev.id,
    slug: ev.slug,
    flagged_for_review: ev.flagged === 1,
    active_reasons: rows.filter((r) => !r.clearedAt).map((r) => r.reason),
    history: rows.map((r) => ({
      reason: r.reason,
      raised_at: toSec(r.raisedAt),
      raised_by: r.raisedBy,
      cleared_at: toSec(r.clearedAt),
      cleared_by: r.clearedBy,
      note: r.note,
    })),
  };
}

export function registerEventReviewFlagTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_event_review_flags",
    "OPE-767 — WHY an event is flagged for review: its active reasons, and the history of every reason raised and cleared (who, when, note). Reasons: " +
      EVENT_REVIEW_FLAG_REASONS.join(", ") +
      ". Read-only. Admin only.",
    { event_id: z.string().min(1) },
    async ({ event_id }) => {
      const state = await flagState(db, event_id);
      if (!state)
        return { content: [jsonContent({ error: "event_not_found", event_id })], isError: true };
      return { content: [jsonContent(state)] };
    }
  );

  server.tool(
    "clear_event_review_flag",
    "OPE-767 — discharge ONE review reason on an event after you have looked at it (e.g. confirmed a rollover's dates, checked a former venue). Clears only that reason; the event stays flagged while any other reason is active. `missing_hours` normally clears itself when the hours are filled in — clear it here only if the hours genuinely cannot be known. `legacy` = flagged before reasons were recorded. Audited. Admin only.",
    {
      event_id: z.string().min(1),
      reason: z.enum(EVENT_REVIEW_FLAG_REASONS),
      note: z
        .string()
        .min(1)
        .max(500)
        .transform(decodeHtmlEntities)
        .describe("What you checked — required, it is the audit record."),
    },
    async ({ event_id, reason, note }) => {
      const before = await flagState(db, event_id);
      if (!before)
        return { content: [jsonContent({ error: "event_not_found", event_id })], isError: true };
      if (!before.active_reasons.includes(reason)) {
        return {
          content: [
            jsonContent({
              error: "reason_not_active",
              message: `'${reason}' is not an active reason on this event; nothing changed.`,
              active_reasons: before.active_reasons,
            }),
          ],
          isError: true,
        };
      }
      await clearEventReviewFlag(db, event_id, reason, auth.userId ?? "mcp", note);
      await db.insert(adminActions).values({
        action: "event.review_flag_cleared",
        actorUserId: auth.userId,
        targetType: "event",
        targetId: event_id,
        payloadJson: JSON.stringify({ reason, note, active_before: before.active_reasons }),
        createdAt: new Date(),
      });
      const after = await flagState(db, event_id);
      return { content: [jsonContent({ success: true, cleared: reason, ...after })] };
    }
  );
}
