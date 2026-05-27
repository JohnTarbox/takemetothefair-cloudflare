/**
 * Idempotent "your submission was reviewed and turned into N events"
 * email notification.
 *
 * Fires when admin manually salvages an inbound_email that the workflow
 * couldn't auto-process. The K1LX case (analyst Item 19, 2026-05-25):
 * a submitter forwarded a hamfest list page, the workflow couldn't
 * extract anything useful, admin hand-created 4 events from the
 * content, the submitter got no follow-up. This helper closes that
 * gap by sending one summary email listing every created event with
 * its public URL.
 *
 * Gated on:
 *   - inbound_emails.from_address IS NOT NULL (we need somewhere to send)
 *   - inbound_emails.salvage_notified_at IS NULL (idempotency — admin
 *     can re-run the salvage UI without double-emailing)
 *   - the supplied event IDs all exist (validated before queueing)
 *
 * Pushes one EmailJobMessage onto EMAIL_JOBS; the MCP-worker consumer
 * drains and sends via env.EMAIL.send(). Sets salvage_notified_at AFTER
 * the queue push so a queue-bound failure doesn't burn the idempotency
 * window — mirrors the approval-notification.ts pattern.
 */

import { eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events, inboundEmails } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

const SUBJECT_PREFIX = "We turned your email into events on Meet Me at the Fair";
const SIGN_OFF = "— Meet Me at the Fair";
const PUBLIC_HOST = "https://meetmeatthefair.com";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface SalvagedEvent {
  name: string;
  slug: string;
}

function buildText(subject: string, salvaged: SalvagedEvent[]): string {
  const count = salvaged.length;
  const lines = salvaged
    .map((e) => `  • ${e.name}\n    ${PUBLIC_HOST}/events/${e.slug}`)
    .join("\n\n");
  const intro = subject
    ? `Thanks for your email about "${subject}". We reviewed your submission`
    : `Thanks for your email. We reviewed your submission`;
  return `${intro} and created ${count} event${count === 1 ? "" : "s"} from it:

${lines}

Some details may have been adjusted during review — please reply to this thread if anything needs correction.

${SIGN_OFF}`;
}

function buildHtml(subject: string, salvaged: SalvagedEvent[]): string {
  const text = buildText(subject, salvaged);
  return `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

export interface NotifySalvageEnv {
  EMAIL_JOBS?: Queue<unknown>;
}

export type NotifySalvageOutcome =
  | "sent"
  | "skipped:not-found"
  | "skipped:no-from-address"
  | "skipped:already-notified"
  | "skipped:no-events"
  | "error:event-not-found"
  | "error:queue-missing";

export interface NotifySalvageResult {
  outcome: NotifySalvageOutcome;
  /** Number of events listed in the salvage email. 0 when outcome is
   *  any "skipped:*" / "error:*". */
  eventsListed: number;
}

/**
 * Validate inputs, build the salvage email, push to EMAIL_JOBS, and set
 * the idempotency marker. Returns a structured outcome so callers can
 * log without inferring from side effects.
 *
 * Caller is responsible for the linkage write (inbound_emails.resulting_event_id
 * and/or status). This helper only handles the notification.
 */
export async function notifySalvageIfNeeded(
  db: Db,
  env: NotifySalvageEnv,
  inboundEmailId: string,
  eventIds: string[]
): Promise<NotifySalvageResult> {
  if (eventIds.length === 0) {
    return { outcome: "skipped:no-events", eventsListed: 0 };
  }

  const [row] = await db
    .select({
      id: inboundEmails.id,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      salvageNotifiedAt: inboundEmails.salvageNotifiedAt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);

  if (!row) return { outcome: "skipped:not-found", eventsListed: 0 };
  if (!row.fromAddress) return { outcome: "skipped:no-from-address", eventsListed: 0 };
  if (row.salvageNotifiedAt !== null) {
    return { outcome: "skipped:already-notified", eventsListed: 0 };
  }

  // Look up all events in one batched query so a single missing ID
  // fails fast without partial-email risk.
  const eventRows = await db
    .select({ id: events.id, name: events.name, slug: events.slug })
    .from(events)
    .where(inArray(events.id, eventIds));

  if (eventRows.length !== eventIds.length) {
    return { outcome: "error:event-not-found", eventsListed: 0 };
  }
  if (!env.EMAIL_JOBS) return { outcome: "error:queue-missing", eventsListed: 0 };

  // Preserve caller-supplied order so admin can curate the list (most-
  // important first, e.g. the parent festival before sub-events).
  const orderById = new Map(eventRows.map((e) => [e.id, e]));
  const ordered: SalvagedEvent[] = [];
  for (const id of eventIds) {
    const e = orderById.get(id);
    if (e) ordered.push({ name: e.name, slug: e.slug as unknown as string });
  }

  const subject = row.subject?.slice(0, 200) ?? "";
  const msg: EmailJobMessage = {
    to: row.fromAddress,
    subject: SUBJECT_PREFIX,
    text: buildText(subject, ordered),
    html: buildHtml(subject, ordered),
    source: "email:submission-salvaged",
  };

  await env.EMAIL_JOBS.send(msg);

  await db
    .update(inboundEmails)
    .set({ salvageNotifiedAt: new Date() })
    .where(eq(inboundEmails.id, inboundEmailId));

  return { outcome: "sent", eventsListed: ordered.length };
}
