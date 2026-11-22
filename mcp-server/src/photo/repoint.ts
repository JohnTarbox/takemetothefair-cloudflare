/**
 * OPE-1697 — move a photo-intake upload from the fair it was attributed to,
 * to the fair it was actually taken at.
 *
 * On 2026-11-21 13 Snap uploads from South Portland High School were sent to
 * the church fair ~350 m away. The links they auto-wrote were moved by hand in
 * raw D1, and the two STAGED proposals could not be moved at all: a proposal's
 * fair is `payload_json.event_id` on its `admin_actions` row, and the approve
 * route (booth-proposals/resolve) writes the vendor link to exactly that id.
 *
 * What moves, for one inbound row, from `from` (its `resulting_event_id`) to `to`:
 *   1. every UNRESOLVED photo decision row for the upload (booth / performer
 *      proposals, performer confirmations, gallery + signage records):
 *      `payload_json.event_id` → `to`, with `repointed_from` kept beside it.
 *      A proposal already approved/rejected (`vendor.photo_resolved`) is NOT
 *      moved — its link exists already; it is reported so a person can act.
 *   2. every `vendor.photo_autowritten` link THIS upload created on `from`:
 *      the `event_vendors` row moves to `to` (or is dropped when `to` already
 *      lists that vendor). A link that EXISTED before the upload
 *      (`was_already_linked`) is left on `from` — the upload did not make it,
 *      so moving it would delete a fact somebody else recorded — and the
 *      vendor is linked on `to` as well.
 *   3. the inbound row: `resulting_event_id` → `to`; for a snap,
 *      `capture_meta.event_id/slug` → `to` and `event_choice_basis='picked'`
 *      (a person has now named the fair).
 *   4. one `photo_intake.repointed` audit row.
 *
 * NOT moved: gallery rows already in `event_photos` (they carry no link back to
 * the upload). Their count is reported from the decision rows so a person can
 * see whether there is anything to clean up by hand.
 *
 * Idempotent: every step converges, so a re-run after a partial failure
 * finishes the job, and a re-run after success changes nothing.
 */
import { and, eq, inArray } from "drizzle-orm";
import { adminActions, eventVendors, events, inboundEmails } from "../schema.js";
import type { Db } from "../db.js";
import { chunkedInArray } from "@takemetothefair/utils";
import { parseCaptureMeta, type CaptureMeta } from "./snap-intake.js";
import {
  BOOTH_PROPOSED_ACTION,
  GALLERY_ATTACHED_ACTION,
  PERFORMER_CONFIRMED_ACTION,
  PERFORMER_PROPOSED_ACTION,
  SIGNAGE_RECORDED_ACTION,
} from "./booth-pipeline.js";
import { BOOTH_AUTOWRITTEN_ACTION } from "./auto-write.js";

export const PHOTO_RESOLVED_ACTION = "vendor.photo_resolved";
export const PHOTO_REPOINTED_ACTION = "photo_intake.repointed";

/** The per-photo decision rows the pipeline writes, all keyed to the upload. */
const DECISION_ACTIONS = [
  BOOTH_PROPOSED_ACTION,
  PERFORMER_PROPOSED_ACTION,
  PERFORMER_CONFIRMED_ACTION,
  GALLERY_ATTACHED_ACTION,
  SIGNAGE_RECORDED_ACTION,
] as const;

export interface RepointInput {
  inboundEmailId?: string | null;
  /** An `admin_actions` id of one of the upload's proposals; resolves the upload. */
  proposalId?: string | null;
  toEventId: string;
  dryRun: boolean;
  actorUserId: string | null;
}

export interface RepointResult {
  ok: true;
  dry_run: boolean;
  inbound_email_id: string;
  from_event: { id: string; name: string | null } | null;
  to_event: { id: string; name: string; slug: string };
  proposals_moved: string[];
  proposals_already_resolved: string[];
  links_moved: Array<{ vendor_id: string; business_name: string | null }>;
  links_dropped_as_duplicate: Array<{ vendor_id: string; business_name: string | null }>;
  links_added_kept_on_from: Array<{ vendor_id: string; business_name: string | null }>;
  links_not_found: Array<{ vendor_id: string; business_name: string | null }>;
  gallery_photos_attached_on_from: number;
  already_on_target: boolean;
}

export type RepointOutcome = RepointResult | { ok: false; error: string };

interface Payload {
  event_id?: string;
  vendor_id?: string;
  business_name?: string | null;
  was_linked?: boolean;
  was_already_linked?: boolean;
  attached?: boolean;
  repointed_from?: string;
}

function parse(json: string | null): Payload {
  try {
    const v = JSON.parse(json ?? "{}") as Payload;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export async function repointPhotoIntake(db: Db, input: RepointInput): Promise<RepointOutcome> {
  // ── Which upload ──────────────────────────────────────────────────────
  let inboundId = input.inboundEmailId?.trim() || null;
  if (!inboundId && input.proposalId) {
    const [p] = await db
      .select({ targetType: adminActions.targetType, targetId: adminActions.targetId })
      .from(adminActions)
      .where(eq(adminActions.id, input.proposalId.trim()))
      .limit(1);
    if (!p || p.targetType !== "inbound_email") {
      return { ok: false, error: `no photo proposal with id ${input.proposalId}` };
    }
    inboundId = p.targetId;
  }
  if (!inboundId) return { ok: false, error: "pass inbound_email_id or proposal_id" };

  const [row] = await db
    .select({
      id: inboundEmails.id,
      intent: inboundEmails.intent,
      resultingEventId: inboundEmails.resultingEventId,
      captureMeta: inboundEmails.captureMeta,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundId))
    .limit(1);
  if (!row) return { ok: false, error: `no inbound row ${inboundId}` };
  if (row.intent !== "photo_intake") {
    return { ok: false, error: `inbound row ${inboundId} is ${row.intent}, not photo_intake` };
  }

  const [to] = await db
    .select({ id: events.id, name: events.name, slug: events.slug, mergedInto: events.mergedInto })
    .from(events)
    .where(eq(events.id, input.toEventId))
    .limit(1);
  if (!to) return { ok: false, error: `no event ${input.toEventId}` };
  if (to.mergedInto) {
    return {
      ok: false,
      error: `event ${to.id} is merged into ${to.mergedInto}; re-point to the keeper`,
    };
  }

  // ── The decision rows, and which are already resolved ─────────────────
  const decisions = await db
    .select({
      id: adminActions.id,
      action: adminActions.action,
      payloadJson: adminActions.payloadJson,
    })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.targetType, "inbound_email"),
        eq(adminActions.targetId, inboundId),
        inArray(adminActions.action, [...DECISION_ACTIONS, BOOTH_AUTOWRITTEN_ACTION])
      )
    );

  // `from` is the row's recorded fair; fall back to what its decisions say,
  // so an upload whose row was hand-edited still has a source.
  const fromId =
    row.resultingEventId ??
    decisions.map((d) => parse(d.payloadJson).event_id).find((e): e is string => Boolean(e)) ??
    null;
  let fromEvent: { id: string; name: string | null } | null = null;
  if (fromId) {
    const [f] = await db
      .select({ id: events.id, name: events.name })
      .from(events)
      .where(eq(events.id, fromId))
      .limit(1);
    fromEvent = f ?? { id: fromId, name: null };
  }

  const proposalIds = decisions
    .filter((d) => d.action === BOOTH_PROPOSED_ACTION || d.action === PERFORMER_PROPOSED_ACTION)
    .map((d) => d.id);
  // Chunked: an upload's proposal count is small today, but the bind list
  // grows with row count (D1's 100-param cap; check-d1-inarray-params).
  const resolvedRows = await chunkedInArray(proposalIds, (batch) =>
    db
      .select({ targetId: adminActions.targetId })
      .from(adminActions)
      .where(
        and(eq(adminActions.action, PHOTO_RESOLVED_ACTION), inArray(adminActions.targetId, batch))
      )
  );
  const resolved = new Set(resolvedRows.map((r) => r.targetId));

  const result: RepointResult = {
    ok: true,
    dry_run: input.dryRun,
    inbound_email_id: inboundId,
    from_event: fromEvent,
    to_event: { id: to.id, name: to.name, slug: to.slug },
    proposals_moved: [],
    proposals_already_resolved: [],
    links_moved: [],
    links_dropped_as_duplicate: [],
    links_added_kept_on_from: [],
    links_not_found: [],
    gallery_photos_attached_on_from: 0,
    already_on_target: false,
  };

  const now = new Date();
  for (const d of decisions) {
    const p = parse(d.payloadJson);
    if (d.action === GALLERY_ATTACHED_ACTION && p.attached && p.event_id !== to.id) {
      result.gallery_photos_attached_on_from += 1;
    }
    if (d.action === BOOTH_AUTOWRITTEN_ACTION) continue; // links, below
    if (resolved.has(d.id)) {
      if (p.event_id !== to.id) result.proposals_already_resolved.push(d.id);
      continue;
    }
    if (p.event_id === to.id) continue; // converged (re-run)
    if (d.action === BOOTH_PROPOSED_ACTION || d.action === PERFORMER_PROPOSED_ACTION) {
      result.proposals_moved.push(d.id);
    }
    if (!input.dryRun) {
      await db
        .update(adminActions)
        .set({
          payloadJson: JSON.stringify({
            ...p,
            event_id: to.id,
            repointed_from: p.event_id ?? null,
          }),
        })
        .where(eq(adminActions.id, d.id));
    }
  }

  // ── Links the upload auto-wrote ───────────────────────────────────────
  for (const d of decisions.filter((x) => x.action === BOOTH_AUTOWRITTEN_ACTION)) {
    const p = parse(d.payloadJson);
    const from = p.event_id;
    if (!p.vendor_id || !from || from === to.id) continue;
    const who = { vendor_id: p.vendor_id, business_name: p.business_name ?? null };

    const [onFrom] = await db
      .select({ id: eventVendors.id })
      .from(eventVendors)
      .where(and(eq(eventVendors.eventId, from), eq(eventVendors.vendorId, p.vendor_id)))
      .limit(1);
    const [onTo] = await db
      .select({ id: eventVendors.id })
      .from(eventVendors)
      .where(and(eq(eventVendors.eventId, to.id), eq(eventVendors.vendorId, p.vendor_id)))
      .limit(1);

    if (p.was_already_linked) {
      // The upload did not make this link; leave it, and add the vendor to `to`.
      if (!onTo) {
        result.links_added_kept_on_from.push(who);
        if (!input.dryRun) {
          await db.insert(eventVendors).values({
            eventId: to.id,
            vendorId: p.vendor_id,
            status: "CONFIRMED",
            participationType: "EXHIBITOR",
          } as never);
        }
      }
    } else if (onFrom && onTo) {
      result.links_dropped_as_duplicate.push(who);
      if (!input.dryRun) await db.delete(eventVendors).where(eq(eventVendors.id, onFrom.id));
    } else if (onFrom) {
      result.links_moved.push(who);
      if (!input.dryRun) {
        await db.update(eventVendors).set({ eventId: to.id }).where(eq(eventVendors.id, onFrom.id));
      }
    } else if (!onTo) {
      // The link is gone from `from` (hand-deleted?) and absent from `to`:
      // report it; do not invent a link the upload no longer evidences.
      result.links_not_found.push(who);
    }
    // (!onFrom && onTo) — already moved, e.g. by hand. Only the payload follows.

    if (!input.dryRun) {
      await db
        .update(adminActions)
        .set({ payloadJson: JSON.stringify({ ...p, event_id: to.id, repointed_from: from }) })
        .where(eq(adminActions.id, d.id));
    }
  }

  // ── The upload itself ─────────────────────────────────────────────────
  const meta = parseCaptureMeta(row.captureMeta);
  result.already_on_target =
    row.resultingEventId === to.id &&
    result.proposals_moved.length === 0 &&
    result.links_moved.length === 0 &&
    result.links_dropped_as_duplicate.length === 0 &&
    result.links_added_kept_on_from.length === 0;

  if (!input.dryRun && !result.already_on_target) {
    await db
      .update(inboundEmails)
      .set({
        resultingEventId: to.id,
        ...(meta
          ? {
              captureMeta: JSON.stringify({
                ...meta,
                event_id: to.id,
                event_slug: to.slug,
                event_choice_basis: "picked",
              } satisfies CaptureMeta),
            }
          : {}),
      })
      .where(eq(inboundEmails.id, inboundId));
    await db.insert(adminActions).values({
      action: PHOTO_REPOINTED_ACTION,
      actorUserId: input.actorUserId,
      targetType: "inbound_email",
      targetId: inboundId,
      payloadJson: JSON.stringify({
        from_event_id: fromEvent?.id ?? null,
        to_event_id: to.id,
        proposals_moved: result.proposals_moved,
        proposals_already_resolved: result.proposals_already_resolved,
        links_moved: result.links_moved,
        links_dropped_as_duplicate: result.links_dropped_as_duplicate,
        links_added_kept_on_from: result.links_added_kept_on_from,
        links_not_found: result.links_not_found,
      }),
      createdAt: now,
    } as never);
  }

  return result;
}
