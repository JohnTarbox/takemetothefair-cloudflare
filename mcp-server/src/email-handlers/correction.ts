/**
 * `corrections@` handler — sender claims an event listing is wrong.
 *
 * Persists a row in admin_actions (action: "email.correction_request")
 * so the admin queue picks it up alongside other operational tasks. The
 * full original email already lives in inbound_emails (incl. body
 * excerpt), so the admin_actions row's payload_json just references the
 * inbound row's id rather than duplicating content.
 *
 * Failure handling: D1 insert errors propagate as plain Error. The
 * workflow's dispatch step has retries:{limit:2} so a transient D1 blip
 * gets a second attempt. If both fail, the workflow's outer catch records
 * status='failed' and emits a generic "we had trouble processing your
 * message" reply (rather than the previous always-ack-anyway behavior;
 * acknowledging a correction we never recorded misleads the sender).
 */

import { adminActions } from "../schema.js";
import { getDb } from "../db.js";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
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
};
