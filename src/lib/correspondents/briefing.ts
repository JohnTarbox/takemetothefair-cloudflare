/**
 * OPE-770 — three lines per external email, so answering costs five minutes
 * instead of forty.
 *
 * The lane's real inflow is ~3 external non-spam emails a week. At that volume
 * the bottleneck is not throughput, it is **recognition** — and the measured
 * cost of not recognising is 35 of 46 people never hearing from a human, plus
 * at least one named lost vendor signup (Katie, OPE-634).
 *
 * ## ⚠️ This assembles FACTS. It generates no prose, and that is a hard line.
 *
 * There is no suggested reply here, no summary of what the sender "wants", no
 * confidence score on their request — because **90.7% of live events claim
 * confirmed dates with no citation**, so an auto-responder quoting our stored
 * record would be confidently wrong to a stranger. A plausible wrong answer is
 * worse than a slow right one. Every field below is a row we already hold or a
 * count of rows we already hold.
 *
 * ## Why an admin page rather than a daily email
 *
 * The ticket flags the phase-0 question — "no new sensing loop until its queue
 * drains faster than inflow" — as John's to weigh, and gives the tiebreak:
 * *"If in doubt, ship it as an admin page rather than a scheduled email. A page
 * nobody opens costs nothing; a daily email nobody reads trains John to ignore
 * the channel."* So: a page. Nothing is scheduled and nothing is sent.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inboundEmails, emailSendLedger } from "@/lib/db/schema";
import { isSystemSender } from "@takemetothefair/utils";

type Db = DrizzleD1Database<Record<string, unknown>>;

/**
 * How long an auto-ack may stand as the newest outbound before the sender counts
 * as waiting.
 *
 * 72 hours, from the ticket. This is the REAL waiting queue — not the
 * open-obligation count, which read 21 on 2026-08-29 against a true waiting
 * count of zero.
 */
export const ACK_ONLY_STALE_HOURS = 72;

/** Ledger sources that are an automated acknowledgement, not a human reply. */
const ACK_SOURCES = ["reply:support-ack", "reply:correction-ack", "reply:press-ack"];

export interface CorrespondentRow {
  inboundEmailId: string;
  receivedAt: Date;
  fromAddress: string;
  subject: string | null;
  intent: string | null;
  /** OPE-764. `null` when the row predates capture; 'none' when we looked and found nobody. */
  matchedEntityType: string | null;
  matchedEntityId: string | null;
  matchBasis: string | null;
  /**
   * OPE-763. Omitted (undefined) rather than defaulted when absent.
   *
   * The ticket is explicit: "omit the field rather than showing a fabricated
   * 'unknown' that reads as reassurance". A NULL here predates capture; the
   * string 'unknown' means we looked and the transport gave us nothing.
   */
  senderAuth?: string;
  /** How many messages this address has sent us, all time, including this one. */
  priorMessageCount: number;
  /** First contact ⇔ priorMessageCount === 1. Stated because it is the decision. */
  isFirstContact: boolean;
  /** Newest outbound to this address, if any. */
  lastOutboundAt: Date | null;
  lastOutboundSource: string | null;
  /** True when the newest outbound is an automated ack and nothing since. */
  ackOnly: boolean;
  /** ackOnly AND older than ACK_ONLY_STALE_HOURS — the real waiting queue. */
  waitingOnUs: boolean;
}

export interface CorrespondentBriefing {
  windowDays: number;
  generatedAt: Date;
  /** Everything in the window, newest first. */
  rows: CorrespondentRow[];
  /** The subset that is waiting on us, surfaced at the top of the page. */
  waiting: CorrespondentRow[];
  /**
   * How many inbound rows the window held BEFORE external filtering.
   *
   * A positive landmark, deliberately reported: "0 correspondents" is a useful
   * answer only when you can see whether it means a quiet week or a filter that
   * matched nothing. Half of `inbound_emails` is our own notify@→alert@ traffic.
   */
  scannedTotal: number;
  filteredSystemSenders: number;
}

/**
 * Is this address one of ours / a machine?
 *
 * `isSystemSender` covers no-reply-shaped local parts; the own-domain check
 * covers our own alerting traffic, which is roughly half the table.
 */
function isExternalSender(fromAddress: string | null | undefined): boolean {
  const addr = (fromAddress ?? "").trim().toLowerCase();
  if (!addr) return false;
  if (isSystemSender(addr)) return false;
  return !addr.endsWith("@meetmeatthefair.com");
}

/**
 * Assemble the briefing.
 *
 * Bounded reads: one window scan, one prior-count aggregate over the addresses
 * found, one outbound lookup over the same addresses. No per-row queries — the
 * N+1 shape would be invisible at 3 emails a week and quadratic the day it is
 * pointed at a backfill.
 */
export async function buildCorrespondentBriefing(
  db: Db,
  opts: { windowDays?: number; now?: Date } = {}
): Promise<CorrespondentBriefing> {
  const windowDays = opts.windowDays ?? 7;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const scanned = await db
    .select({
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      intent: inboundEmails.intent,
      matchedEntityType: inboundEmails.matchedEntityType,
      matchedEntityId: inboundEmails.matchedEntityId,
      matchBasis: inboundEmails.matchBasis,
      senderAuth: inboundEmails.senderAuth,
    })
    .from(inboundEmails)
    .where(and(gte(inboundEmails.receivedAt, since), isNotNull(inboundEmails.fromAddress)))
    .orderBy(desc(inboundEmails.receivedAt));

  const external = scanned.filter((r) => isExternalSender(r.fromAddress));
  const addresses = [...new Set(external.map((r) => (r.fromAddress ?? "").toLowerCase()))];

  if (addresses.length === 0) {
    return {
      windowDays,
      generatedAt: now,
      rows: [],
      waiting: [],
      scannedTotal: scanned.length,
      filteredSystemSenders: scanned.length,
    };
  }

  // All-time message counts per address — "have they written before" is the
  // single most useful line, and it is not answerable from the window alone.
  const priorRows = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      n: sql<number>`count(*)`,
    })
    .from(inboundEmails)
    .where(inArray(sql`lower(${inboundEmails.fromAddress})`, addresses))
    .groupBy(sql`lower(${inboundEmails.fromAddress})`);
  const priorByAddress = new Map(
    priorRows.map((r) => [(r.fromAddress ?? "").toLowerCase(), Number(r.n)])
  );

  const outboundRows = await db
    .select({
      recipient: emailSendLedger.recipient,
      sentAt: emailSendLedger.sentAt,
      source: emailSendLedger.source,
    })
    .from(emailSendLedger)
    .where(
      and(
        inArray(sql`lower(${emailSendLedger.recipient})`, addresses),
        eq(emailSendLedger.status, "sent")
      )
    )
    .orderBy(desc(emailSendLedger.sentAt));

  // Newest per recipient. The list is already sorted, so first wins.
  const lastOutbound = new Map<string, { sentAt: Date; source: string | null }>();
  for (const r of outboundRows) {
    const key = (r.recipient ?? "").toLowerCase();
    if (!lastOutbound.has(key)) lastOutbound.set(key, { sentAt: r.sentAt, source: r.source });
  }

  const staleBefore = new Date(now.getTime() - ACK_ONLY_STALE_HOURS * 60 * 60 * 1000);

  const rows: CorrespondentRow[] = external.map((r) => {
    const key = (r.fromAddress ?? "").toLowerCase();
    const out = lastOutbound.get(key) ?? null;
    const ackOnly = out ? ACK_SOURCES.includes(out.source ?? "") : false;
    const priorMessageCount = priorByAddress.get(key) ?? 1;
    return {
      inboundEmailId: r.id,
      receivedAt: r.receivedAt,
      fromAddress: r.fromAddress ?? "",
      subject: r.subject,
      intent: r.intent,
      matchedEntityType: r.matchedEntityType,
      matchedEntityId: r.matchedEntityId,
      matchBasis: r.matchBasis,
      // Omitted entirely when we have nothing — never rendered as a reassuring
      // "unknown" the sender never earned.
      ...(r.senderAuth ? { senderAuth: r.senderAuth } : {}),
      priorMessageCount,
      isFirstContact: priorMessageCount <= 1,
      lastOutboundAt: out?.sentAt ?? null,
      lastOutboundSource: out?.source ?? null,
      ackOnly,
      // Never heard from a human at all, OR the only thing they got was an
      // automated ack that has now been standing for three days.
      waitingOnUs: out === null ? r.receivedAt < staleBefore : ackOnly && out.sentAt < staleBefore,
    };
  });

  return {
    windowDays,
    generatedAt: now,
    rows,
    waiting: rows.filter((r) => r.waitingOnUs),
    scannedTotal: scanned.length,
    filteredSystemSenders: scanned.length - external.length,
  };
}
