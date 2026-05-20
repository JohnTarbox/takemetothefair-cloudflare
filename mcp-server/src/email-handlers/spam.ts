/**
 * Spam handler — silent quarantine path for emails the classifier flagged
 * as spam with confidence ≥ SPAM_QUARANTINE_THRESHOLD.
 *
 * The entrypoint short-circuits true spam BEFORE creating a workflow (see
 * email-handler.ts) — INSERTs the audit row, never calls
 * `env.INBOUND_EMAIL.create()`, never `message.forward()`, never auto-
 * replies. Pattern mirrors the rate-limit silent-drop at email-handler.ts:
 * 148-163. So in practice this handler should rarely run.
 *
 * It exists for one case: admin reclassifies an existing inbound row to
 * `spam` via the D.1 UI and chooses "also re-run workflow". The workflow
 * dispatches here, we record the reclassification in admin_actions, and
 * exit with no reply (matches the entrypoint's silent-drop semantics).
 */

import { adminActions } from "../schema.js";
import { getDb } from "../db.js";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);
  await db.insert(adminActions).values({
    action: "email.spam_quarantine",
    actorUserId: null,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({
      from: row.fromAddress,
      to: row.toAddress,
      subject: row.subject ?? null,
      reason: "classifier-routed-to-spam",
    }),
    createdAt: new Date(),
  });

  // No auto-reply: replying to spam confirms a live inbox.
  // No admin forward: the row is in inbound_emails for audit; admin sees
  // it via /admin/inbound-emails with a `flagged_for_review` filter.
  return {
    replyKind: null,
    status: "forwarded",
  };
};
