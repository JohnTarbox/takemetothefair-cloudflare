/**
 * OPE-978 — "emails in, outcomes out" for the photo-intake lane.
 *
 * `list_photo_proposals` could only count proposals, so a photo that went
 * anywhere else — the gallery, an auto-write, or nowhere — was invisible from
 * it. Specimen: the 2026-09-12 New Gloucester batch was 20 emails and the tool
 * reported "18 staged, 0 vision failures"; the other two had been classified as
 * scenery and attached to the event gallery (`photos_stored: 1` on both rows,
 * `event_photos` rows 13 s and 20 s after receipt). Nothing was lost, and
 * nothing could SHOW that nothing was lost.
 *
 * Every photo the pipeline examines now leaves exactly one decision row keyed
 * by (inbound email, photo_key). This reconciles those rows against the images
 * the emails actually carried, and names whatever is left over.
 *
 * Emails processed before 2026-09-13 have no `photo.gallery_attached` rows; for
 * them the row's own `photos_stored` count stands in for the gallery outcome.
 * That legacy fallback is reported as its own number, never folded into the
 * row-backed one.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import { adminActions, inboundEmails } from "../schema.js";
import type { Db } from "../db.js";
import { imageRefs, parseRefs } from "../email-handlers/photo-intake.js";
import {
  BOOTH_PROPOSED_ACTION,
  GALLERY_ATTACHED_ACTION,
  PERFORMER_CONFIRMED_ACTION,
  PERFORMER_PROPOSED_ACTION,
  SIGNAGE_RECORDED_ACTION,
} from "./booth-pipeline.js";
import { BOOTH_AUTOWRITTEN_ACTION } from "./auto-write.js";

const OUTCOME_OF: Record<string, string> = {
  [BOOTH_PROPOSED_ACTION]: "booth_proposed",
  [BOOTH_AUTOWRITTEN_ACTION]: "booth_autowritten",
  [PERFORMER_PROPOSED_ACTION]: "performer_proposed",
  [PERFORMER_CONFIRMED_ACTION]: "performer_confirmed",
  [SIGNAGE_RECORDED_ACTION]: "signage_recorded",
  [GALLERY_ATTACHED_ACTION]: "gallery_attached",
};

export interface IntakeAccounting {
  window: { since: string; until: string };
  emails_in: number;
  photos_in: number;
  /** Emails whose fair was never resolved — the pipeline does not run on them. */
  emails_held_unmatched: number;
  outcomes: Record<string, number>;
  /** Gallery attaches inferred from photos_stored on pre-2026-09-13 rows. */
  gallery_legacy_count: number;
  unaccounted_count: number;
  unaccounted: Array<{
    inbound_email_id: string;
    received_at: string;
    photo_key: string;
    photo_name: string;
    email_status: string | null;
  }>;
}

export async function computeIntakeAccounting(
  db: Db,
  since: Date,
  until: Date = new Date()
): Promise<IntakeAccounting> {
  const emails = await db
    .select({
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      status: inboundEmails.status,
      attachmentRefs: inboundEmails.attachmentRefs,
      photosStored: inboundEmails.photosStored,
      resultingEventId: inboundEmails.resultingEventId,
    })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.intent, "photo_intake"),
        gte(inboundEmails.receivedAt, since),
        lte(inboundEmails.receivedAt, until)
      )
    );

  const decisions = new Map<string, Map<string, string>>(); // email → photo_key → outcome
  const actions = Object.keys(OUTCOME_OF);
  for (const batch of chunkIds(emails.map((e) => e.id))) {
    const rows = await db
      .select({
        targetId: adminActions.targetId,
        action: adminActions.action,
        payload: adminActions.payloadJson,
      })
      .from(adminActions)
      .where(and(inArray(adminActions.targetId, batch), inArray(adminActions.action, actions)));
    for (const r of rows) {
      let key: string | undefined;
      try {
        key = (JSON.parse(r.payload ?? "{}") as { photo_key?: string }).photo_key;
      } catch {
        key = undefined;
      }
      if (!key || !r.targetId) continue;
      const m = decisions.get(r.targetId) ?? new Map<string, string>();
      if (!m.has(key)) m.set(key, OUTCOME_OF[r.action]);
      decisions.set(r.targetId, m);
    }
  }

  const outcomes: Record<string, number> = Object.fromEntries(
    Object.values(OUTCOME_OF).map((o) => [o, 0])
  );
  let photosIn = 0;
  let held = 0;
  let legacyGallery = 0;
  const unaccounted: IntakeAccounting["unaccounted"] = [];

  for (const e of emails) {
    const images = imageRefs(parseRefs(e.attachmentRefs));
    photosIn += images.length;
    if (images.length === 0) continue;
    if (!e.resultingEventId) {
      held++;
      continue;
    }
    const decided = decisions.get(e.id) ?? new Map<string, string>();
    const hasGalleryRows = [...decided.values()].includes("gallery_attached");
    let legacyBudget = hasGalleryRows ? 0 : (e.photosStored ?? 0);
    for (const img of images) {
      const outcome = decided.get(img.key);
      if (outcome) {
        outcomes[outcome]++;
      } else if (legacyBudget > 0) {
        legacyBudget--;
        legacyGallery++;
      } else {
        unaccounted.push({
          inbound_email_id: e.id,
          received_at:
            e.receivedAt instanceof Date ? e.receivedAt.toISOString() : String(e.receivedAt),
          photo_key: img.key,
          photo_name: img.name,
          email_status: e.status ?? null,
        });
      }
    }
  }

  return {
    window: { since: since.toISOString(), until: until.toISOString() },
    emails_in: emails.length,
    photos_in: photosIn,
    emails_held_unmatched: held,
    outcomes,
    gallery_legacy_count: legacyGallery,
    unaccounted_count: unaccounted.length,
    unaccounted: unaccounted.slice(0, 50),
  };
}
