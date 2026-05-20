/**
 * `corrections@` handler — sender claims an event listing is wrong.
 *
 * Persists a row in admin_actions (action: "email.correction_request")
 * so the admin queue picks it up alongside other operational tasks. The
 * full original email already lives in inbound_emails (incl. body
 * excerpt), so the admin_actions row's payload_json just references the
 * inbound row's id rather than duplicating content.
 *
 * --- C.9 partial — slug-only disambiguation ---
 * If the body contains a `meetmeatthefair.com/events/<slug>` URL, we
 * extract the slug and resolve it to an event ID. That fills in the
 * "exact-URL match" tier of the spec's 3-tier disambiguation cheaply
 * (just a slug lookup) and lets the admin queue jump straight to the
 * right row.
 *
 * Tier 2 (name + venue fuzzy match → multi-match ambiguity prompt) and
 * tier 3 (free-text name-only fallback) are deferred — they need a
 * proper fuzzy matcher coordinated with src/lib/venue-matching.ts, which
 * lives in the main app rather than mcp-server. Search for the
 * `targetEventId` payload field in admin_actions to see which rows the
 * slug-tier resolved cleanly vs which need the full fuzzy match.
 *
 * --- C.10 (date-drift cross-check) — deferred ---
 * Not in this handler. The drift check requires fetching the canonical
 * source URL + parsing dates, which lives in the main app's url-import
 * pipeline. When wired, it'll fire as a follow-up step on rows with
 * targetEventId set + a date-field clue in body text.
 *
 * Failure handling: D1 insert errors propagate as plain Error. The
 * workflow's dispatch step has retries:{limit:2} so a transient D1 blip
 * gets a second attempt. If both fail, the workflow's outer catch records
 * status='failed' and emits a generic "we had trouble processing your
 * message" reply (rather than the previous always-ack-anyway behavior;
 * acknowledging a correction we never recorded misleads the sender).
 */

import { adminActions, events } from "../schema.js";
import { getDb } from "../db.js";
import { unsafeSlug } from "../helpers.js";
import { eq } from "drizzle-orm";
import type { HandlerFn, HandlerResult } from "./types.js";

const SLUG_URL_RE = /https?:\/\/(?:www\.)?meetmeatthefair\.com\/events\/([a-z0-9][a-z0-9-]*)/i;

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);

  const bodyForScan = `${row.subject ?? ""}\n${row.bodyTextExcerpt ?? ""}`;
  const slug = extractEventSlug(bodyForScan);

  let targetEventId: string | null = null;
  let targetEventStatus: string | null = null;
  if (slug) {
    // unsafeSlug: boundary cast — `slug` is freshly extracted from an
    // email body URL, not a stored slug. The events.slug column is
    // branded Slug per CLAUDE.md slug-typing rules.
    const matches = await db
      .select({ id: events.id, status: events.status })
      .from(events)
      .where(eq(events.slug, unsafeSlug(slug)))
      .limit(1);
    if (matches.length === 1) {
      targetEventId = matches[0].id;
      targetEventStatus = matches[0].status;
    }
  }

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
      // C.9 partial — slug-extraction tier
      extractedSlug: slug,
      targetEventId,
      targetEventStatus,
    }),
    createdAt: new Date(),
  });

  return {
    replyKind: "correction-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
  };
};

/** Pull the first `meetmeatthefair.com/events/<slug>` slug from text,
 *  or null if none found. Loose URL match — handles `www.` prefix,
 *  trailing punctuation, and slug-only path components. Exported for
 *  unit tests. */
export function extractEventSlug(text: string): string | null {
  const m = text.match(SLUG_URL_RE);
  if (!m) return null;
  return (m[1] || "").toLowerCase().replace(/-+$/, "") || null;
}
