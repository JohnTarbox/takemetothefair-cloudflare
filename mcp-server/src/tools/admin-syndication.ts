// SYN1 (Dev-Email-2026-06-12 §A3) — subscriber registry admin tools. Adding a
// consumer is a registry INSERT, not a deploy: the emitter holds zero
// subscriber-specific code. Admin only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  syndicationSubscribers,
  syndicationSubscriptions,
  events,
  adminActions,
} from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerSyndicationTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // ── register_syndication_subscriber ───────────────────────────
  server.tool(
    "register_syndication_subscriber",
    "Register a syndication consumer (e.g. a partner site mirroring event data). Returns the subscriber id. Use add_syndication_subscription to attach the event IDs they track. The signing_secret is used to HMAC-SHA256 every webhook to this subscriber's callback_url. Admin only.",
    {
      name: z.string().min(1).max(120).describe("Human label, e.g. 'maine-cardworks'."),
      callback_url: z.string().url().describe("HTTPS endpoint that receives signed webhooks."),
      signing_secret: z
        .string()
        .min(16)
        .max(256)
        .describe("Shared secret for HMAC-SHA256 request signing (≥16 chars)."),
    },
    async (params) => {
      // Reject a duplicate callback_url to avoid two subscriber rows racing
      // deliveries to the same endpoint with different secrets.
      const existing = await db
        .select({ id: syndicationSubscribers.id })
        .from(syndicationSubscribers)
        .where(eq(syndicationSubscribers.callbackUrl, params.callback_url))
        .limit(1);
      if (existing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A subscriber with callback_url ${params.callback_url} already exists (id: ${existing[0].id}).`,
            },
          ],
          isError: true,
        };
      }

      const id = crypto.randomUUID();
      const now = new Date();
      await db.insert(syndicationSubscribers).values({
        id,
        name: params.name,
        callbackUrl: params.callback_url,
        signingSecret: params.signing_secret,
        active: true,
        createdAt: now,
      });
      await db.insert(adminActions).values({
        action: "syndication.subscriber.register",
        actorUserId: auth.userId,
        targetType: "syndication_subscriber",
        targetId: id,
        payloadJson: JSON.stringify({ name: params.name, callbackUrl: params.callback_url }),
        createdAt: now,
      });
      return { content: [jsonContent({ registered: true, subscriber_id: id })] };
    }
  );

  // ── add_syndication_subscription ──────────────────────────────
  server.tool(
    "add_syndication_subscription",
    "Subscribe a registered subscriber to one or more event IDs. Idempotent — event IDs already subscribed are skipped. Returns the added + skipped counts. Admin only.",
    {
      subscriber_id: z
        .string()
        .min(1)
        .describe("Subscriber id from register_syndication_subscriber."),
      // Capped at 100 to stay under D1's 100-bound-parameter-per-statement
      // limit on the existence check below. Call repeatedly for larger sets.
      event_ids: z.array(z.string().min(1)).min(1).max(100).describe("Event IDs to track."),
    },
    async (params) => {
      const [subscriber] = await db
        .select({ id: syndicationSubscribers.id })
        .from(syndicationSubscribers)
        .where(eq(syndicationSubscribers.id, params.subscriber_id))
        .limit(1);
      if (!subscriber) {
        return {
          content: [{ type: "text", text: "Subscriber not found." }],
          isError: true,
        };
      }

      const uniqueIds = [...new Set(params.event_ids)];
      // Only subscribe to events that exist + aren't already subscribed.
      const existingEvents = await db
        .select({ id: events.id })
        .from(events)
        .where(inArray(events.id, uniqueIds));
      const validEventIds = new Set(existingEvents.map((e) => e.id));

      const alreadySubscribed = await db
        .select({ eventId: syndicationSubscriptions.eventId })
        .from(syndicationSubscriptions)
        .where(eq(syndicationSubscriptions.subscriberId, params.subscriber_id));
      const alreadySet = new Set(alreadySubscribed.map((s) => s.eventId));

      const toAdd = uniqueIds.filter((id) => validEventIds.has(id) && !alreadySet.has(id));
      const now = new Date();
      if (toAdd.length > 0) {
        await db.insert(syndicationSubscriptions).values(
          toAdd.map((eventId) => ({
            id: crypto.randomUUID(),
            subscriberId: params.subscriber_id,
            eventId,
            createdAt: now,
          }))
        );
      }
      return {
        content: [
          jsonContent({
            added: toAdd.length,
            skipped_existing: uniqueIds.filter((id) => alreadySet.has(id)).length,
            skipped_unknown_event: uniqueIds.filter((id) => !validEventIds.has(id)).length,
          }),
        ],
      };
    }
  );

  // ── remove_syndication_subscription ───────────────────────────
  server.tool(
    "remove_syndication_subscription",
    "Stop a subscriber from tracking an event ID. Admin only.",
    {
      subscriber_id: z.string().min(1),
      event_id: z.string().min(1),
    },
    async (params) => {
      await db
        .delete(syndicationSubscriptions)
        .where(
          and(
            eq(syndicationSubscriptions.subscriberId, params.subscriber_id),
            eq(syndicationSubscriptions.eventId, params.event_id)
          )
        );
      return { content: [jsonContent({ removed: true })] };
    }
  );

  // ── list_syndication_subscribers ──────────────────────────────
  server.tool(
    "list_syndication_subscribers",
    "List registered syndication subscribers with their tracked-event counts. Secrets are NOT returned. Admin only.",
    {},
    async () => {
      const subs = await db
        .select({
          id: syndicationSubscribers.id,
          name: syndicationSubscribers.name,
          callbackUrl: syndicationSubscribers.callbackUrl,
          active: syndicationSubscribers.active,
          createdAt: syndicationSubscribers.createdAt,
        })
        .from(syndicationSubscribers)
        .orderBy(syndicationSubscribers.createdAt);

      // Subscription counts via a single grouped query, merged in memory
      // (avoids a correlated subquery + keeps secrets out of the response).
      const counts = await db
        .select({
          subscriberId: syndicationSubscriptions.subscriberId,
          eventCount: sql<number>`COUNT(*)`,
        })
        .from(syndicationSubscriptions)
        .groupBy(syndicationSubscriptions.subscriberId);
      const countById = new Map(counts.map((c) => [c.subscriberId, Number(c.eventCount)]));

      return {
        content: [
          jsonContent({
            subscribers: subs.map((s) => ({ ...s, eventCount: countById.get(s.id) ?? 0 })),
          }),
        ],
      };
    }
  );

  // ── set_syndication_subscriber_active ─────────────────────────
  server.tool(
    "set_syndication_subscriber_active",
    "Enable or disable a subscriber. Disabled subscribers receive no webhooks but keep their subscriptions. Admin only.",
    {
      subscriber_id: z.string().min(1),
      active: z.boolean(),
    },
    async (params) => {
      await db
        .update(syndicationSubscribers)
        .set({ active: params.active })
        .where(eq(syndicationSubscribers.id, params.subscriber_id));
      return {
        content: [jsonContent({ subscriber_id: params.subscriber_id, active: params.active })],
      };
    }
  );
}
