// SYN1 (Dev-Email-2026-06-12 §A) — syndication dispatcher (MCP Worker consumer).
//
// Each queue message names one entity whose mirrored fields changed. The
// consumer drains that entity's UNPROCESSED `syndication_outbox` rows, resolves
// the affected EVENT ids (notification grain is per-event), and POSTs an
// HMAC-SHA256-signed webhook to every active subscriber tracking each event.
//
// Resilience model:
//   • The durable outbox — not the message — is the source of truth. Draining
//     by `(entity, processed_at IS NULL)` makes a lost/duplicated message
//     self-healing.
//   • Delivery is idempotent on the consumer side (the receiver keeps the
//     highest `eventVersion`), so a retry that re-POSTs an already-delivered
//     event is harmless.
//   • A row is marked `processed_at` only after ALL its deliveries succeed; any
//     failure throws → the whole message retries (Queue backoff) → DLQ after
//     max_retries. Already-processed rows are filtered out on retry.
import { and, eq, isNull } from "drizzle-orm";
import {
  syndicationOutbox,
  syndicationSubscribers,
  syndicationSubscriptions,
  events,
  eventDays,
  venues,
} from "../schema.js";
import { buildEventSnapshot, type SyndicationChangeMessage } from "@takemetothefair/utils";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";

const MAX_ROWS_PER_ENTITY = 200;

type QueueMessage<T> = { body: T; ack: () => void; retry: () => void };
type Batch<T> = { queue: string; messages: readonly QueueMessage<T>[] };
type Env = { DB: D1Database };

export async function handleSyndicationBatch(
  batch: Batch<SyndicationChangeMessage>,
  env: Env
): Promise<void> {
  const db = getDb(env.DB);
  for (const msg of batch.messages) {
    try {
      await processSyndicationEntity(db, msg.body);
      msg.ack();
    } catch (err) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:syndication:dispatch",
        message: "syndication delivery failed; retrying",
        error: err,
        context: { entityType: msg.body?.entityType, entityId: msg.body?.entityId },
      });
      msg.retry();
    }
  }
}

/**
 * Drain + deliver every unprocessed outbox row for one entity. Exported for
 * tests (the queue handler builds its own D1-backed `db`; tests inject one).
 */
export async function processSyndicationEntity(
  db: Db,
  body: SyndicationChangeMessage
): Promise<void> {
  const rows = await db
    .select()
    .from(syndicationOutbox)
    .where(
      and(
        eq(syndicationOutbox.entityType, body.entityType),
        eq(syndicationOutbox.entityId, body.entityId),
        isNull(syndicationOutbox.processedAt)
      )
    )
    .orderBy(syndicationOutbox.changeVersion)
    .limit(MAX_ROWS_PER_ENTITY);

  for (const row of rows) {
    const eventIds = await resolveAffectedEventIds(db, row.entityType, row.entityId);
    // Deliver each affected event to each subscriber tracking it. A single
    // failure throws → the row stays unprocessed → message retries.
    for (const eventId of eventIds) {
      await deliverEvent(db, eventId);
    }
    await db
      .update(syndicationOutbox)
      .set({ processedAt: new Date() })
      .where(eq(syndicationOutbox.id, row.id));
  }
}

/** event → [self]; event_day → [parent]; venue → [all events at the venue]. */
async function resolveAffectedEventIds(
  db: Db,
  entityType: string,
  entityId: string
): Promise<string[]> {
  if (entityType === "event") return [entityId];
  if (entityType === "event_day") {
    const [day] = await db
      .select({ eventId: eventDays.eventId })
      .from(eventDays)
      .where(eq(eventDays.id, entityId))
      .limit(1);
    return day ? [day.eventId] : [];
  }
  if (entityType === "venue") {
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.venueId, entityId));
    return rows.map((r) => r.id);
  }
  return [];
}

/** Build the canonical payload for one event + POST it to every subscriber. */
async function deliverEvent(db: Db, eventId: string): Promise<void> {
  const [row] = await db
    .select({
      eventVersion: events.syndicationVersion,
      name: events.name,
      slug: events.slug,
      startDate: events.startDate,
      endDate: events.endDate,
      venueName: venues.name,
      venueAddress: venues.address,
      venueCity: venues.city,
      venueState: venues.state,
      venueZip: venues.zip,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(eq(events.id, eventId))
    .limit(1);

  // Event vanished (deleted between enqueue and dispatch) — nothing to send.
  if (!row) return;

  const subs = await db
    .select({
      callbackUrl: syndicationSubscribers.callbackUrl,
      signingSecret: syndicationSubscribers.signingSecret,
    })
    .from(syndicationSubscriptions)
    .innerJoin(
      syndicationSubscribers,
      eq(syndicationSubscriptions.subscriberId, syndicationSubscribers.id)
    )
    .where(
      and(eq(syndicationSubscriptions.eventId, eventId), eq(syndicationSubscribers.active, true))
    );

  if (subs.length === 0) return;

  const payload = {
    eventId,
    eventVersion: row.eventVersion,
    ...buildEventSnapshot(
      { name: row.name, slug: row.slug, startDate: row.startDate, endDate: row.endDate },
      row.venueName !== null ||
        row.venueAddress !== null ||
        row.venueCity !== null ||
        row.venueState !== null ||
        row.venueZip !== null
        ? {
            name: row.venueName,
            address: row.venueAddress,
            city: row.venueCity,
            state: row.venueState,
            zip: row.venueZip,
          }
        : null
    ),
  };
  const body = JSON.stringify(payload);

  // Throw if any subscriber POST fails so the whole message retries. Other
  // subscribers that already succeeded get a harmless idempotent re-POST.
  const failures: string[] = [];
  for (const sub of subs) {
    try {
      const signature = await hmacSha256Hex(sub.signingSecret, body);
      const res = await fetch(sub.callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Syndication-Signature": `sha256=${signature}`,
          "X-Syndication-Event-Id": eventId,
          "X-Syndication-Event-Version": String(row.eventVersion ?? 0),
        },
        body,
      });
      if (!res.ok) failures.push(`${sub.callbackUrl} → HTTP ${res.status}`);
    } catch (e) {
      failures.push(`${sub.callbackUrl} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`syndication delivery failed for event ${eventId}: ${failures.join("; ")}`);
  }
}

/** HMAC-SHA256 hex digest via Web Crypto (available in Workers). Exported for tests. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
