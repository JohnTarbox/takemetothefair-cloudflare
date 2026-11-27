/**
 * OPE-1722 — the audit row for a newsletter BROADCAST (the whole list, not a
 * test send).
 *
 * The Nov 27 weekend issue went to 121 recipients at 2026-11-27 19:00:53Z and
 * nothing recorded it: no broadcast path wrote `admin_actions`, so "who sent
 * this?" could only be guessed from the timing of a preview email. All three
 * doors into a list call THIS helper so they cannot drift into recording
 * different shapes: the one-tap approve route (token-authenticated),
 * /api/admin/newsletter/send (admin session or X-Internal-Key, i.e. the MCP
 * `send_newsletter_broadcast` tool) and /api/admin/newsletter/vendor-digest
 * (the MCP `send_vendor_digest` tool).
 *
 * Written AFTER the send is claimed (the approve route's `sent_at` latch, the
 * send route's upsert) and after the enqueue attempt, on success AND on an
 * enqueue failure — a partial broadcast still mailed people, so `queued` vs
 * `total` is the part a reader most needs.
 *
 * Best-effort, like `recordMutation`: an audit failure must never fail or
 * change the send it describes. It is logged via `logAuditWriteFailure`.
 */
import { adminActions } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { logAuditWriteFailure } from "@/lib/audit/log-audit-failure";

type Db = DrizzleD1Database<typeof schema>;

export const NEWSLETTER_BROADCAST_ACTION = "newsletter.broadcast";
export const NEWSLETTER_ISSUE_TARGET = "newsletter_issue";

/** How the caller authenticated — the "who" when there is no user id. */
export type NewsletterBroadcastVia = "approve_token" | "admin_session" | "internal_key";

export interface NewsletterBroadcastAudit {
  /** Which route performed the broadcast. */
  route: "approve" | "admin_send" | "vendor_digest";
  via: NewsletterBroadcastVia;
  /** The admin user id when a session sent it; null for a token / internal key. */
  actorUserId: string | null;
  slug: string;
  audience: string;
  subject: string;
  /** Recipients selected for the broadcast. */
  total: number;
  /** Recipients actually enqueued. */
  queued: number;
  /** True when the enqueue threw (a partial or empty broadcast). */
  enqueueFailed: boolean;
  now?: Date;
}

/** Returns whether the row was written. Never throws. */
export async function recordNewsletterBroadcast(
  db: Db,
  a: NewsletterBroadcastAudit
): Promise<boolean> {
  try {
    await db.insert(adminActions).values({
      action: NEWSLETTER_BROADCAST_ACTION,
      actorUserId: a.actorUserId,
      targetType: NEWSLETTER_ISSUE_TARGET,
      targetId: a.slug,
      payloadJson: JSON.stringify({
        route: a.route,
        via: a.via,
        audience: a.audience,
        subject: a.subject,
        total: a.total,
        queued: a.queued,
        enqueue_failed: a.enqueueFailed,
      }),
      createdAt: a.now ?? new Date(),
    });
    return true;
  } catch (error) {
    await logAuditWriteFailure(db, {
      source: `newsletter:${a.route}`,
      action: NEWSLETTER_BROADCAST_ACTION,
      targetType: NEWSLETTER_ISSUE_TARGET,
      targetId: a.slug,
      error,
    });
    return false;
  }
}
