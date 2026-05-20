/**
 * `source_suggestion` handler — sender points us at a website/feed as a
 * potential source of events to harvest. Spec §C.8.
 *
 * Two-tier lookup (current; the spec's full 3-tier requires the
 * discovery_candidates table which doesn't exist yet — see follow-up):
 *
 *   1. Check events.source_url for the suggested host. If we already have
 *      events from this domain (informal usage), the auto-reply tells the
 *      sender we use the source already, and the admin_actions row flags
 *      it as a "register this informal usage" follow-up.
 *   2. No informal usage either → record as a fresh discovery suggestion
 *      for admin to evaluate.
 *
 * Either way we INSERT admin_actions for the audit log + admin queue, and
 * return a `source-suggestion-ack` ReplyKind for the auto-reply.
 *
 * --- Follow-up (NOT in scope for the wired-but-active classifier ship) ---
 * Spec §C.8's full 3-tier check needs a `discovery_candidates` table that
 * doesn't currently exist in the schema. When that table lands (separate
 * project), upgrade this handler to:
 *   tier 1 — discovery_candidates lookup by URL/domain
 *   tier 2 — events.source_url informal-usage check (today's tier 1)
 *   tier 3 — fresh suggestion → INSERT into discovery_candidates
 * Until then, this handler routes through admin_actions like correction.
 * Search for the action name `email.source_suggestion` to find the
 * relevant rows when the upgrade ships.
 */

import { adminActions, events } from "../schema.js";
import { getDb } from "../db.js";
import { sql, like } from "drizzle-orm";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);

  // Extract the first URL from the body excerpt. The full parsed_url field
  // is the entrypoint's pick (first URL); for source suggestions that's
  // usually the suggested source.
  const suggestedUrl = row.parsedUrl ?? extractFirstUrl(row.bodyTextExcerpt ?? "");
  const host = suggestedUrl ? extractHost(suggestedUrl) : null;

  let informalUsageCount = 0;
  if (host) {
    // Tier 2 (current tier 1): does events.source_url already contain
    // this host? `LIKE '%host%'` is loose on purpose — same-domain matches
    // are what we want to detect.
    const rows = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(events)
      .where(like(events.sourceUrl, `%${host}%`))
      .limit(1);
    informalUsageCount = Number(rows[0]?.n ?? 0);
  }

  await db.insert(adminActions).values({
    action: "email.source_suggestion",
    actorUserId: null,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({
      from: row.fromAddress,
      subject: row.subject ?? null,
      suggestedUrl,
      suggestedHost: host,
      informalUsageCount,
      bodyExcerpt: row.bodyTextExcerpt ?? null,
    }),
    createdAt: new Date(),
  });

  return {
    replyKind: "source-suggestion-ack",
    replyParams: {
      suggestedHost: host ?? "",
      informalUsageCount,
    },
    status: "replied",
  };
};

function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
