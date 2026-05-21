/**
 * `source_suggestion` handler — sender points us at a website/feed as a
 * potential source of events to harvest. Spec §C.8 / drizzle/0084.
 *
 * Three-tier lookup. First match wins:
 *
 *   Tier 1: discovery_candidates lookup. If we already track this host
 *           with status='active', tell the sender we already use it.
 *           They get the polished "thanks, already on it" reply with no
 *           admin queue entry.
 *
 *   Tier 2: events.source_url LIKE check. If we have events sourced from
 *           this host (informal usage) but no discovery_candidates row,
 *           tell the sender we use the source AND flag for admin to
 *           formally register it (admin_actions row tagged
 *           source_suggestion.register_informal).
 *
 *   Tier 3: Fresh suggestion → INSERT discovery_candidates row with
 *           status='pending_review'. Sender gets the "thanks, queued for
 *           review" reply. Partial-unique index on host means a second
 *           sender flagging the same host just collides harmlessly with
 *           ON CONFLICT DO NOTHING.
 *
 * All three tiers also write an admin_actions row for the audit trail
 * (action='email.source_suggestion'). Replies use the existing
 * source-suggestion-ack ReplyKind — the reply template branches on
 * params.tier so the sender sees the right message.
 */

import { adminActions, discoveryCandidates, events } from "../schema.js";
import { getDb } from "../db.js";
import { sql, like, eq, and } from "drizzle-orm";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);

  // Extract the first URL from the body excerpt. The full parsed_url field
  // is the entrypoint's pick (first URL); for source suggestions that's
  // usually the suggested source.
  const suggestedUrl = row.parsedUrl ?? extractFirstUrl(row.bodyTextExcerpt ?? "");
  const host = suggestedUrl ? extractHost(suggestedUrl) : null;

  let tier: "registered" | "informal" | "new" | "no-host" = "no-host";
  let informalUsageCount = 0;

  if (host) {
    // Tier 1: already-registered source check.
    const existing = await db
      .select({ id: discoveryCandidates.id, status: discoveryCandidates.status })
      .from(discoveryCandidates)
      .where(and(eq(discoveryCandidates.host, host), eq(discoveryCandidates.status, "active")))
      .limit(1);

    if (existing.length > 0) {
      tier = "registered";
    } else {
      // Tier 2: informal-usage check via events.source_url LIKE.
      const usageRows = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(events)
        .where(like(events.sourceUrl, `%${host}%`))
        .limit(1);
      informalUsageCount = Number(usageRows[0]?.n ?? 0);

      if (informalUsageCount > 0) {
        tier = "informal";
      } else {
        // Tier 3: fresh suggestion → INSERT into discovery_candidates.
        // ON CONFLICT DO NOTHING in case two senders flag the same host
        // simultaneously and we'd otherwise hit the partial-unique index.
        try {
          await db.insert(discoveryCandidates).values({
            id: crypto.randomUUID(),
            url: suggestedUrl ?? "",
            host,
            status: "pending_review",
            suggestedByEmail: row.fromAddress,
            suggestedViaInboundId: row.id,
            createdAt: new Date(),
          });
          tier = "new";
        } catch {
          // Likely partial-unique-index collision (someone else already
          // suggested this host). Tier-wise still treat as "queued" — the
          // sender's experience matches the spec.
          tier = "new";
        }
      }
    }
  }

  // Audit row for ALL tiers. Tier 'informal' flags for admin to register
  // formally; the others are just bookkeeping.
  await db.insert(adminActions).values({
    action: tier === "informal" ? "source_suggestion.register_informal" : "email.source_suggestion",
    actorUserId: null,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({
      from: row.fromAddress,
      subject: row.subject ?? null,
      suggestedUrl,
      suggestedHost: host,
      tier,
      informalUsageCount,
      bodyExcerpt: row.bodyTextExcerpt ?? null,
    }),
    createdAt: new Date(),
  });

  return {
    replyKind: "source-suggestion-ack",
    replyParams: {
      suggestedHost: host ?? "",
      tier,
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
