/**
 * `corrections@` handler — sender claims an event listing is wrong.
 *
 * Persists a row in admin_actions (action: "email.correction_request")
 * so the admin queue picks it up alongside other operational tasks. The
 * full original email already lives in inbound_emails (incl. body
 * excerpt), so the admin_actions row's payload_json just references the
 * inbound row's id rather than duplicating content.
 */

import { adminActions } from "../schema.js";
import { getDb } from "../db.js";
import { logError } from "../logger.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE = "mcp:email-handler:correction";

export const handle: HandlerFn = async (env, ctx, row): Promise<HandlerResult> => {
  try {
    const db = getDb(env.DB);
    await db.insert(adminActions).values({
      action: "email.correction_request",
      actorUserId: null,
      targetType: "inbound_email",
      targetId: row.id,
      payloadJson: JSON.stringify({
        from: row.fromAddress,
        subject: row.subject ?? null,
        bodyExcerpt: row.bodyTextExcerpt ?? null,
        receivedAt: row.receivedAt,
      }),
      createdAt: new Date(),
    });
    return {
      replyKind: "correction-ack",
      replyParams: { subject: row.subject ?? "" },
      status: "replied",
    };
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "failed to insert admin_actions row for correction request",
      error: err,
      sessionId: ctx.sessionId,
      context: { inboundEmailId: row.id, from: row.fromAddress },
    });
    return {
      replyKind: "correction-ack",
      replyParams: { subject: row.subject ?? "" },
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
