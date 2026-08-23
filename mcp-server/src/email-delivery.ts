/**
 * OPE-177 — consume Cloudflare Email Sending lifecycle events.
 *
 * Producer: an account-level event subscription on the `meetmeatthefair.com`
 * sending domain, publishing to the `email-delivery-events` queue. Not code in
 * this repo — see drizzle/0193 and the ticket. Until that subscription exists,
 * this consumer is correct and idle, which is why its heartbeat probe ships
 * dormant.
 *
 * What it does, in order, per message:
 *   1. Store the raw event in `email_delivery_events` (PK = event_id, so an
 *      at-least-once redelivery is a no-op).
 *   2. Try to attribute it to an `email_send_ledger` row via provider_message_id.
 *   3. If attributed, fold the outcome into `email_send_ledger.delivery_status`
 *      — but only if it does not DOWNGRADE what we already know.
 *   4. Hard bounce or spam complaint → `email_suppression_list`.
 *
 * Step 1 is deliberately independent of steps 2–4: the id spaces may not line
 * up (see the migration), and an ingest that can only be observed through a
 * successful match is an ingest that reports "all clear" when it is broken.
 */

import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db.js";
import { emailDeliveryEvents, emailSendLedger, emailSuppressionList } from "./schema.js";
import { logError } from "./logger.js";

/** Shape published by the Email Sending source (eventSchemaVersion 1). Every
 *  field is optional on the wire — a future schema version must not throw. */
export interface EmailSendingEvent {
  type?: string;
  source?: { type?: string; zoneId?: string; domain?: string };
  payload?: {
    eventId?: string;
    messageId?: string;
    sender?: string;
    recipient?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: {
      status?: string;
      provider?: string;
      deliveryTimeMs?: number;
      smtpStatusCode?: string;
      smtpEnhancedStatusCode?: string;
      smtpResponse?: string;
    };
    bounce?: { type?: string; classification?: string; reason?: string };
  };
  metadata?: {
    accountId?: string;
    eventSubscriptionId?: string;
    eventSchemaVersion?: number;
    eventTimestamp?: string;
  };
}

/**
 * How much a delivery outcome is allowed to overwrite the one already recorded.
 *
 * Events are not ordered. A `deferred` published before a `delivered` can be
 * consumed after it, and applying it blindly would turn a delivered message back
 * into "temporarily failing" — worse than no signal, because it is a confident
 * wrong answer. Rank ordering makes late arrivals harmless.
 *
 * `complained` outranks `delivered` on purpose: a spam complaint necessarily
 * happens after delivery and is the outcome that matters. `rejected` and
 * `failed` sit with `bounced` — all three mean the recipient never got it.
 */
export type DeliveryStatus =
  | "delivered"
  | "deferred"
  | "bounced"
  | "failed"
  | "rejected"
  | "complained";

const STATUS_RANK: Record<DeliveryStatus, number> = {
  deferred: 1,
  delivered: 2,
  bounced: 3,
  failed: 3,
  rejected: 3,
  complained: 4,
};

/** An unrecognized status from a future schema version is still STORED in
 *  email_delivery_events (raw text), but must not be written into the ledger's
 *  typed column — where a value nothing understands would just look like a
 *  delivery state to every reader. */
export function isDeliveryStatus(s: string): s is DeliveryStatus {
  return s in STATUS_RANK;
}

/** Derive the delivery status from the event, preferring the explicit
 *  `delivery.status` and falling back to parsing the event type
 *  (`cf.email.sending.message.bounced` → `bounced`). One of the two is always
 *  present in practice; relying on only one would drop events if the other
 *  moves. */
export function deliveryStatusOf(ev: EmailSendingEvent): string | null {
  const explicit = ev.payload?.delivery?.status?.toLowerCase();
  if (explicit) return explicit;
  const fromType = ev.type?.split(".").pop()?.toLowerCase();
  return fromType && fromType in STATUS_RANK ? fromType : null;
}

/**
 * Candidate spellings of a provider message id, so matching survives the one
 * thing we could not settle by reading docs: whether the event's `messageId` is
 * the same string we stored.
 *
 * We store what the CF binding returns — an RFC 5322 Message-ID *with* angle
 * brackets, `<abc@meetmeatthefair.com>`. The documented event payload shows a
 * bare id. Rather than guess, match on both spellings with exact equality.
 *
 * SETTLED IN PRODUCTION 2026-08-23: live events carry the *angle-bracket* form,
 * so the documentation is wrong and the stored spelling is the one that matches.
 * 91/91 events resolved to a ledger row with zero unmatched warns. Keep the
 * both-spellings tolerance anyway — it costs one array entry, it is the only
 * reason this worked on day one, and the docs remain free to become true later.
 *
 * Exact equality (via IN) and never LIKE: D1 caps a LIKE pattern at 50
 * characters and a Message-ID can exceed that. That cap is invisible locally —
 * better-sqlite3 allows 50000 — and has already broken one matcher in this
 * codebase (OPE-404).
 */
export function messageIdCandidates(raw: string | null | undefined): string[] {
  const v = (raw ?? "").trim();
  if (!v) return [];
  const bare = v.replace(/^</, "").replace(/>$/, "");
  const wrapped = `<${bare}>`;
  return Array.from(new Set([v, bare, wrapped]));
}

/** True when this event means the address must never be mailed again.
 *  Soft bounces and deferrals must NOT suppress — a full mailbox or a greylist
 *  is temporary, and suppressing on it would quietly blacklist a real user. */
export function shouldSuppress(status: string, bounceType: string | null | undefined): boolean {
  if (status === "complained") return true;
  if (status === "bounced") return (bounceType ?? "").toLowerCase() === "hard";
  return false;
}

interface DeliveryEnv {
  DB: D1Database;
}

/**
 * Process one batch. Per-message ack/retry — never whole-batch — so one
 * malformed event cannot force reprocessing of the good ones (which, for
 * suppression, would mean re-deciding to block an address).
 */
export async function handleEmailDeliveryBatch(
  batch: MessageBatch<EmailSendingEvent>,
  env: DeliveryEnv,
  db: Db
): Promise<void> {
  const sessionId = crypto.randomUUID();

  for (const m of batch.messages) {
    try {
      await processDeliveryEvent(db, env, m.body, sessionId);
      m.ack();
    } catch (e) {
      await logError(env.DB, {
        source: "mcp:email-delivery",
        message: "delivery event processing failed; will retry",
        sessionId,
        context: {
          attempts: m.attempts,
          error: e instanceof Error ? e.message : String(e),
          eventId: m.body?.payload?.eventId ?? null,
        },
      });
      // 15s, 30s, 60s. Delivery events are informational — nothing downstream
      // is waiting on them in real time — so a slower backoff is fine and keeps
      // a provider-side blip from hot-looping.
      m.retry({ delaySeconds: Math.min(60, 15 * 2 ** Math.max(0, m.attempts - 1)) });
    }
  }
}

export async function processDeliveryEvent(
  db: Db,
  env: DeliveryEnv,
  ev: EmailSendingEvent,
  sessionId: string
): Promise<void> {
  const status = deliveryStatusOf(ev);
  const payload = ev.payload ?? {};
  // An event with no id cannot be deduped, and inventing one would let a
  // redelivery double-apply. Record the fault and drop it rather than guess.
  const eventId = payload.eventId;
  if (!eventId || !status) {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:email-delivery",
      message: "unusable delivery event (missing eventId or status) — dropped",
      sessionId,
      context: { type: ev.type ?? null, hasEventId: Boolean(eventId), status },
    });
    return;
  }

  const now = new Date();
  const eventTimestamp = parseTimestamp(ev.metadata?.eventTimestamp);
  const bounceType = payload.bounce?.type ?? null;

  // Resolve the ledger row FIRST so the stored event carries its attribution,
  // then insert once. ON CONFLICT DO NOTHING is the idempotency guard: a
  // redelivered event neither re-suppresses nor re-applies.
  const candidates = messageIdCandidates(payload.messageId);
  const ledgerRow =
    candidates.length > 0
      ? (
          await db
            .select({
              messageId: emailSendLedger.messageId,
              deliveryStatus: emailSendLedger.deliveryStatus,
            })
            .from(emailSendLedger)
            .where(inArray(emailSendLedger.providerMessageId, candidates))
            .limit(1)
        )[0]
      : undefined;

  const inserted = await db
    .insert(emailDeliveryEvents)
    .values({
      eventId,
      eventType: ev.type ?? "unknown",
      status,
      providerMessageId: payload.messageId ?? null,
      recipient: payload.recipient ?? null,
      sender: payload.sender ?? null,
      subject: payload.subject ?? null,
      terminal: payload.terminal ?? null,
      smtpStatusCode: payload.delivery?.smtpStatusCode ?? null,
      smtpResponse: payload.delivery?.smtpResponse ?? null,
      bounceType,
      bounceClassification: payload.bounce?.classification ?? null,
      eventTimestamp,
      receivedAt: now,
      ledgerMessageId: ledgerRow?.messageId ?? null,
    })
    .onConflictDoNothing({ target: emailDeliveryEvents.eventId })
    .returning({ eventId: emailDeliveryEvents.eventId });

  // Already processed on an earlier delivery — stop here. Everything below
  // (suppression, ledger state) was applied then.
  if (inserted.length === 0) return;

  if (!ledgerRow) {
    // Loud on purpose. The whole feature rests on the assumption that the
    // event's messageId is the id we stored, and this is the only place that
    // assumption is testable. Volume is ~15 sends/day, so a warn per unmatched
    // event is affordable; if it turns out to be every event, that is the
    // finding, not noise.
    await logError(env.DB, {
      level: "warn",
      source: "mcp:email-delivery",
      message: "delivery event did not match any send ledger row",
      sessionId,
      context: {
        eventId,
        status,
        providerMessageId: payload.messageId ?? null,
        recipient: payload.recipient ?? null,
      },
    });
  } else if (isDeliveryStatus(status) && outranks(status, ledgerRow.deliveryStatus)) {
    await db
      .update(emailSendLedger)
      .set({
        deliveryStatus: status,
        deliveryUpdatedAt: now,
        deliveryDetail: JSON.stringify({
          smtpStatusCode: payload.delivery?.smtpStatusCode ?? null,
          smtpResponse: payload.delivery?.smtpResponse ?? null,
          bounceType,
          bounceClassification: payload.bounce?.classification ?? null,
        }),
      })
      .where(eq(emailSendLedger.messageId, ledgerRow.messageId));
  }

  if (shouldSuppress(status, bounceType)) {
    await suppressRecipient(db, payload.recipient, status);
  }
}

/** A later event may only raise the recorded outcome, never lower it. */
export function outranks(next: string, current: string | null | undefined): boolean {
  if (!current) return true;
  const rank = (s: string) => (isDeliveryStatus(s) ? STATUS_RANK[s] : 0);
  return rank(next) >= rank(current);
}

async function suppressRecipient(
  db: Db,
  recipient: string | null | undefined,
  status: string
): Promise<void> {
  const email = (recipient ?? "").trim().toLowerCase();
  if (!email) return;
  // The list is keyed on lowercase email; DO NOTHING preserves the ORIGINAL
  // reason. An address the operator suppressed by hand should not be relabelled
  // 'bounce' by a later event.
  await db
    .insert(emailSuppressionList)
    .values({
      email,
      reason: status === "complained" ? "complaint" : "bounce",
      source: "cf-delivery-event",
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: emailSuppressionList.email });
}

function parseTimestamp(raw: string | undefined): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}
