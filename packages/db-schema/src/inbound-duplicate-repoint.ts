/**
 * OPE-1352 — when an event loses a duplicate adjudication, the inbound email
 * that produced it follows the keeper.
 *
 * `inbound_emails.resulting_event_id` answers "where did this submission land?".
 * Submitter-quality scoring, the answered/support state, "did this land?" checks
 * and replays all follow it. When the event it names is then rejected as a
 * duplicate (`rejected_as_duplicate_of`, OPE-450) or merged away (`merged_into`),
 * the pointer was left on the losing row — so every one of those readers saw a
 * REJECTED event and read a submission that actually matched a live listing as
 * a failure. Specimen: UMF Chester Greenwood craft fair, inbound f8ef71e5 still
 * naming the rejected e15e22a7 instead of the keeper 7b8ac15d. Measured
 * 2026-10-15: 18 inbound rows (10 rejected-as-duplicate, 8 merged) in that state.
 *
 * One function, called by all three adjudication writers — the MCP
 * `update_event_status` tool, the app's flag-queue reject, and `mergeEvents` —
 * for the same reason `repointVenueChildren` is shared: a fix wired into one of
 * several parallel paths is the defect class this project keeps re-learning.
 *
 * ── Why an admin_actions row and not an `original_resulting_event_id` column ──
 *
 * The original value is recorded as one `admin_actions` row per repointed inbound
 * (`from_event_id` → `to_event_id`), the ledger every adjudication already
 * writes to. A column would hold only ONE prior value; a keeper that is later
 * merged repoints the same inbound a second time, and the column would either
 * overwrite the true original or freeze at the first hop. The ledger keeps the
 * whole chain, needs no migration on a hot table, and the loser is still
 * recoverable from the loser row itself (it is never deleted).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";

type Db = DrizzleD1Database<typeof schema>;

export const INBOUND_REPOINT_ACTION = "inbound_email.resulting_event_repoint";

export type InboundRepointReason = "rejected_as_duplicate_of" | "merged_into";

/** A chain longer than this is treated as corrupt and NOT followed. */
export const MAX_KEEPER_HOPS = 10;

/**
 * Follow `merged_into` (preferred — an executed merge) then
 * `rejected_as_duplicate_of` from `startId` to the first row that carries
 * neither. Returns null when the start row does not exist, the chain cycles,
 * or it is longer than {@link MAX_KEEPER_HOPS}: in all three cases there is no
 * keeper we can name honestly, and leaving the pointer alone is better than
 * guessing.
 */
export async function resolveLiveKeeper(db: Db, startId: string): Promise<string | null> {
  const seen = new Set<string>();
  let cur = startId;
  for (let hop = 0; hop <= MAX_KEEPER_HOPS; hop++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const [row] = await db
      .select({
        id: schema.events.id,
        mergedInto: schema.events.mergedInto,
        rejectedAsDuplicateOf: schema.events.rejectedAsDuplicateOf,
      })
      .from(schema.events)
      .where(eq(schema.events.id, cur))
      .limit(1);
    if (!row) return null;
    const next = row.mergedInto ?? row.rejectedAsDuplicateOf;
    if (!next) return row.id;
    cur = next;
  }
  return null;
}

export interface InboundRepointResult {
  /** The live keeper the inbound rows now name, or null if nothing could be resolved. */
  keeperId: string | null;
  /** Inbound email ids whose `resulting_event_id` moved off the loser. */
  repointed: string[];
}

/** D1 caps bound parameters at 100 per statement. */
const CHUNK = 50;
/** admin_actions binds 7 params per row. */
const AUDIT_CHUNK = 12;

export async function repointInboundEmailsToKeeper(
  db: Db,
  input: {
    loserId: string;
    /** The keeper the adjudication NAMED; the live end of its chain is what gets written. */
    keeperId: string;
    reason: InboundRepointReason;
    actorUserId: string | null;
    now?: Date;
  }
): Promise<InboundRepointResult> {
  const { loserId, reason } = input;
  if (!loserId || !input.keeperId || loserId === input.keeperId) {
    return { keeperId: null, repointed: [] };
  }

  const inbound = await db
    .select({ id: schema.inboundEmails.id })
    .from(schema.inboundEmails)
    .where(eq(schema.inboundEmails.resultingEventId, loserId));
  if (inbound.length === 0) return { keeperId: null, repointed: [] };

  const keeperId = await resolveLiveKeeper(db, input.keeperId);
  // A chain that leads back to the loser has no live keeper to name.
  if (!keeperId || keeperId === loserId) return { keeperId: null, repointed: [] };

  const ids = inbound.map((r) => r.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    await db
      .update(schema.inboundEmails)
      .set({ resultingEventId: keeperId })
      .where(
        and(
          inArray(schema.inboundEmails.id, ids.slice(i, i + CHUNK)),
          eq(schema.inboundEmails.resultingEventId, loserId)
        )
      );
  }

  const now = input.now ?? new Date();
  const audit = ids.map((id) => ({
    action: INBOUND_REPOINT_ACTION,
    actorUserId: input.actorUserId,
    targetType: "inbound_email",
    targetId: id,
    payloadJson: JSON.stringify({
      from_event_id: loserId,
      to_event_id: keeperId,
      // Differs from to_event_id only when the named keeper was itself a loser.
      named_keeper_id: input.keeperId,
      reason,
    }),
    createdAt: now,
  }));
  for (let i = 0; i < audit.length; i += AUDIT_CHUNK) {
    await db.insert(schema.adminActions).values(audit.slice(i, i + AUDIT_CHUNK));
  }

  return { keeperId, repointed: ids };
}
