/**
 * OPE-1341 — what the phone shows under each thumbnail, read from the record.
 *
 * A snap is an `inbound_emails` row (see mcp-server/src/photo/snap-intake.ts), so
 * its outcome is already stored: the Workflow's `status`/`reply_kind`, the fair it
 * decided (`resulting_event_id`), and one `admin_actions` row per photo decision
 * keyed on the row id. This module only reads those — it never infers an outcome
 * the lane did not record.
 */
import { and, inArray } from "drizzle-orm";
import { chunkedInArray } from "@takemetothefair/utils";
import { adminActions, events, inboundEmails } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

/** Action strings mirror mcp-server/src/photo/booth-pipeline.ts + auto-write.ts. */
export const SNAP_DECISION_ACTIONS = {
  boothProposed: "vendor.photo_proposed",
  boothAutowritten: "vendor.photo_autowritten",
  performerProposed: "performer.photo_proposed",
  performerConfirmed: "performer.photo_confirmed",
  galleryAttached: "photo.gallery_attached",
  signageRecorded: "photo.signage_not_presence",
  // OPE-1705 — business cards.
  cardApplied: "vendor.card_applied",
  cardProposed: "vendor.card_proposed",
  // OPE-1705 slice 2 — a card paired with the booth shot before it.
  cardPaired: "vendor.card_paired",
} as const;

export type SnapPhase =
  | "processing" // stored; the lane has not finished with it
  | "matched" // fair found; see `outcome` for what happened to the photo
  | "held" // the lane could not tell which fair
  | "poster" // read as an event poster; staged as a pending event
  | "failed";

export interface SnapStatus {
  id: string;
  phase: SnapPhase;
  /** Short line for the thumbnail. */
  label: string;
  eventId: string | null;
  eventName: string | null;
  locationSource: string | null;
  outcome: {
    boothProposals: number;
    boothAutowritten: number;
    performer: number;
    gallery: number;
    signage: number;
    /** OPE-1705 — cards matched to a vendor, and the vendor each matched. */
    cardApplied?: number;
    cardVendorName?: string | null;
    /** OPE-1705 — cards staged for review. */
    cardProposed?: number;
    /** OPE-1705 slice 2 — the booth this card was paired with, and how. */
    cardPairedWith?: string | null;
    cardPairing?: string | null;
  };
}

export interface SnapRowFacts {
  id: string;
  status: string;
  replyKind: string | null;
  resultingEventId: string | null;
  captureMeta: string | null;
  error: string | null;
}

const EMPTY_OUTCOME = {
  boothProposals: 0,
  boothAutowritten: 0,
  performer: 0,
  gallery: 0,
  signage: 0,
};

/** Pure: row facts + decision counts → the phone's status line. */
export function describeSnap(
  row: SnapRowFacts,
  eventName: string | null,
  outcome: SnapStatus["outcome"] = EMPTY_OUTCOME
): SnapStatus {
  let locationSource: string | null = null;
  let choiceBasis: string | null = null;
  try {
    const cm = row.captureMeta
      ? (JSON.parse(row.captureMeta) as { location_source?: string; event_choice_basis?: string })
      : null;
    locationSource = cm?.location_source ?? null;
    choiceBasis = cm?.event_choice_basis ?? null;
  } catch {
    locationSource = null;
  }
  const base = { id: row.id, eventId: row.resultingEventId, eventName, locationSource, outcome };

  if (row.status === "failed") {
    return { ...base, phase: "failed", label: "Failed — it is in the admin inbox for a retry" };
  }
  if (row.status === "received" || row.status === "processing" || !row.replyKind) {
    return { ...base, phase: "processing", label: "Uploaded — identifying…" };
  }
  if (row.replyKind === "photo-intake-poster") {
    return { ...base, phase: "poster", label: "Read as a poster — staged as a pending event" };
  }
  // OPE-1697 — the server held auto-write: the fair was a guess between
  // several. Say so on the phone, where the photographer can still fix it.
  if (row.replyKind === "photo-intake-ack" && choiceBasis === "auto_nearest_ambiguous") {
    return {
      ...base,
      phase: "held",
      label: `Not written — more than one fair is close by and none was picked (guessed ${eventName ?? "a fair"}). Pick the fair; this one is in review.`,
    };
  }
  if (row.replyKind === "photo-intake-ack" && row.resultingEventId) {
    const parts: string[] = [];
    if (outcome.boothAutowritten) parts.push(`${outcome.boothAutowritten} vendor added`);
    if (outcome.boothProposals) parts.push(`${outcome.boothProposals} booth for review`);
    if (outcome.performer) parts.push(`${outcome.performer} performer`);
    if (outcome.gallery) parts.push(`${outcome.gallery} to gallery`);
    if (outcome.signage) parts.push("sign recorded");
    const paired = cardPairedLabel(outcome);
    if (paired) parts.push(paired);
    else if (outcome.cardApplied)
      parts.push(
        outcome.cardApplied === 1 && outcome.cardVendorName
          ? `Business card → ${outcome.cardVendorName}`
          : `${outcome.cardApplied} business card${outcome.cardApplied === 1 ? "" : "s"} matched`
      );
    if (outcome.cardProposed && !paired)
      parts.push(`${outcome.cardProposed} card only — for review`);
    const what = parts.length ? parts.join(", ") : "matched";
    return { ...base, phase: "matched", label: `${eventName ?? "Matched"} — ${what}` };
  }
  // photo-intake-unresolved (and -held, which a snap should never reach).
  const why =
    locationSource === "none" ? "no location and no pinned fair" : "no fair found here today";
  return { ...base, phase: "held", label: `Held — ${why}. Pin the fair and re-snap.` };
}

/** OPE-1705 slice 2 — the card's line once it is paired with a booth, else null. */
export function cardPairedLabel(outcome: SnapStatus["outcome"]): string | null {
  if (!outcome.cardPairing) return null;
  const booth = outcome.cardPairedWith ?? "the booth before it";
  if (outcome.cardPairing === "confirmed") return `Business card → paired with ${booth}`;
  if (outcome.cardPairing === "unreadable_booth")
    return "Business card → named the unreadable booth before it — for review";
  return `Business card → after ${booth}, names differ — for review`;
}

/** Load statuses for the given snap row ids (≤ 50, snap rows only). */
export async function loadSnapStatuses(db: Db, ids: string[]): Promise<SnapStatus[]> {
  const wanted = ids.filter((id) => /^snap-[0-9a-f-]{36}$/.test(id)).slice(0, 50);
  if (wanted.length === 0) return [];

  const rows = await db
    .select({
      id: inboundEmails.id,
      status: inboundEmails.status,
      replyKind: inboundEmails.replyKind,
      resultingEventId: inboundEmails.resultingEventId,
      captureMeta: inboundEmails.captureMeta,
      error: inboundEmails.error,
    })
    .from(inboundEmails)
    .where(and(inArray(inboundEmails.id, wanted)));

  const eventIds = [
    ...new Set(rows.map((r) => r.resultingEventId).filter((x): x is string => !!x)),
  ];
  const names = new Map<string, string>();
  if (eventIds.length) {
    for (const e of await chunkedInArray(eventIds, (batch) =>
      db.select({ id: events.id, name: events.name }).from(events).where(inArray(events.id, batch))
    )) {
      names.set(e.id, e.name);
    }
  }

  const counts = new Map<string, SnapStatus["outcome"]>();
  const actions = Object.values(SNAP_DECISION_ACTIONS);
  for (const a of await db
    .select({
      targetId: adminActions.targetId,
      action: adminActions.action,
      payloadJson: adminActions.payloadJson,
    })
    .from(adminActions)
    .where(and(inArray(adminActions.targetId, wanted), inArray(adminActions.action, actions)))) {
    if (!a.targetId) continue;
    const c: SnapStatus["outcome"] = { ...(counts.get(a.targetId) ?? EMPTY_OUTCOME) };
    if (a.action === SNAP_DECISION_ACTIONS.boothProposed) c.boothProposals++;
    else if (a.action === SNAP_DECISION_ACTIONS.boothAutowritten) c.boothAutowritten++;
    else if (
      a.action === SNAP_DECISION_ACTIONS.performerProposed ||
      a.action === SNAP_DECISION_ACTIONS.performerConfirmed
    )
      c.performer++;
    else if (a.action === SNAP_DECISION_ACTIONS.galleryAttached) c.gallery++;
    else if (a.action === SNAP_DECISION_ACTIONS.signageRecorded) c.signage++;
    else if (a.action === SNAP_DECISION_ACTIONS.cardApplied) {
      c.cardApplied = (c.cardApplied ?? 0) + 1;
      try {
        const n = (JSON.parse(a.payloadJson ?? "{}") as { vendor_name?: unknown }).vendor_name;
        c.cardVendorName = typeof n === "string" ? n : null;
      } catch {
        c.cardVendorName = null;
      }
    } else if (a.action === SNAP_DECISION_ACTIONS.cardProposed)
      c.cardProposed = (c.cardProposed ?? 0) + 1;
    else if (a.action === SNAP_DECISION_ACTIONS.cardPaired) {
      try {
        const p = JSON.parse(a.payloadJson ?? "{}") as {
          pairing?: unknown;
          booth_business_name?: unknown;
        };
        c.cardPairing = typeof p.pairing === "string" ? p.pairing : null;
        c.cardPairedWith = typeof p.booth_business_name === "string" ? p.booth_business_name : null;
      } catch {
        c.cardPairing = null;
      }
    }
    counts.set(a.targetId, c);
  }

  return rows.map((r) =>
    describeSnap(
      r,
      r.resultingEventId ? (names.get(r.resultingEventId) ?? null) : null,
      counts.get(r.id)
    )
  );
}
