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
  try {
    locationSource = row.captureMeta
      ? ((JSON.parse(row.captureMeta) as { location_source?: string }).location_source ?? null)
      : null;
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
  if (row.replyKind === "photo-intake-ack" && row.resultingEventId) {
    const parts: string[] = [];
    if (outcome.boothAutowritten) parts.push(`${outcome.boothAutowritten} vendor added`);
    if (outcome.boothProposals) parts.push(`${outcome.boothProposals} booth for review`);
    if (outcome.performer) parts.push(`${outcome.performer} performer`);
    if (outcome.gallery) parts.push(`${outcome.gallery} to gallery`);
    if (outcome.signage) parts.push("sign recorded");
    const what = parts.length ? parts.join(", ") : "matched";
    return { ...base, phase: "matched", label: `${eventName ?? "Matched"} — ${what}` };
  }
  // photo-intake-unresolved (and -held, which a snap should never reach).
  const why =
    locationSource === "none" ? "no location and no pinned fair" : "no fair found here today";
  return { ...base, phase: "held", label: `Held — ${why}. Pin the fair and re-snap.` };
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
    for (const e of await db
      .select({ id: events.id, name: events.name })
      .from(events)
      .where(inArray(events.id, eventIds))) {
      names.set(e.id, e.name);
    }
  }

  const counts = new Map<string, SnapStatus["outcome"]>();
  const actions = Object.values(SNAP_DECISION_ACTIONS);
  for (const a of await db
    .select({ targetId: adminActions.targetId, action: adminActions.action })
    .from(adminActions)
    .where(and(inArray(adminActions.targetId, wanted), inArray(adminActions.action, actions)))) {
    if (!a.targetId) continue;
    const c = { ...(counts.get(a.targetId) ?? EMPTY_OUTCOME) };
    if (a.action === SNAP_DECISION_ACTIONS.boothProposed) c.boothProposals++;
    else if (a.action === SNAP_DECISION_ACTIONS.boothAutowritten) c.boothAutowritten++;
    else if (
      a.action === SNAP_DECISION_ACTIONS.performerProposed ||
      a.action === SNAP_DECISION_ACTIONS.performerConfirmed
    )
      c.performer++;
    else if (a.action === SNAP_DECISION_ACTIONS.galleryAttached) c.gallery++;
    else if (a.action === SNAP_DECISION_ACTIONS.signageRecorded) c.signage++;
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
