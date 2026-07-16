/**
 * OPE-204 (Milestone A) — booth-photo → vendor IDENTIFICATION + staging.
 *
 * For each photo on a fair-resolved `photos@` email, ask the vision model whose
 * booth it is, then stage the answer for operator review. Emits one
 * `admin_actions` row per identified booth and flags the inbound row.
 *
 * ── What this milestone deliberately does NOT do ──────────────────────────
 * It does not create vendors, link them to events, or set hero images. That
 * auto-write tail is Milestone B, and it is held back on purpose:
 *
 *   1. OPE-6 / customer-facing. Writing here publishes a real business as a
 *      CONFIRMED exhibitor at a real fair, from an email. John's standing
 *      instruction (2026-07-15) is "build gated OFF, decide later".
 *   2. Nobody has measured this vision model's accuracy on real booth photos
 *      yet. Wiring a public write to an unmeasured classifier is backwards —
 *      the staged rows ARE the measurement. Once John has seen a few real
 *      batches, Milestone B turns on with a known false-positive rate.
 *
 * The whole stage is additionally gated behind PHOTO_VISION_ENABLED, so it
 * costs zero AI spend until explicitly switched on (the EMAIL_REPLY_ENABLED
 * `=== "true"` default-OFF precedent).
 *
 * ── Staging mechanism ─────────────────────────────────────────────────────
 * `admin_actions` + `flagged_for_review=1`, exactly the OPE-176 roster
 * stage-for-review pattern (`inbound-email.ts:790-827`). Deliberately NOT
 * `vendor_enrichment_candidates`: that table is field-level enrichment of an
 * EXISTING vendor (`vendor_id` NOT NULL, one `proposed_field`), which cannot
 * express "maybe a new vendor, maybe existing X, link to event Y".
 */
import { adminActions, inboundEmails } from "../schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { identifyBooth, disposition, type VisionAi, type Disposition } from "./vision.js";
import { attachGeneralPhotos } from "./general-photos.js";
import { autoWriteBooths, type AutoWriteOutcome } from "./auto-write.js";

/** Audit action for a staged booth identification. */
export const BOOTH_PROPOSED_ACTION = "vendor.photo_proposed";

/**
 * Photos to run vision over in one email.
 *
 * The receive-time capture already caps at 5 attachments
 * (ATTACHMENT_MAX_COUNT), so this is a belt-and-braces bound on AI spend and
 * on the inbound workflow's time budget rather than a real limit.
 */
export const MAX_PHOTOS_PER_EMAIL = 5;

export interface PipelinePhoto {
  /** R2 key under inbound-attachments/... */
  key: string;
  name: string;
}

export interface BoothPipelineResult {
  /** Photos actually run through vision. */
  examined: number;
  /** Identifications staged for review (needs a human). */
  staged: number;
  /** General (non-booth) scenery — the input to the gallery attach below. */
  skipped: number;
  /** Business names staged OR auto-written, for the reply. */
  identifiedNames: string[];
  /** OPE-205 §3 — general photos attached to the event as gallery candidates. */
  galleryAttached: number;
  /** General photos we tried but couldn't attach. Reported, never swallowed. */
  galleryFailed: number;
  /**
   * OPE-204 Milestone B — booths auto-written (created/linked as CONFIRMED
   * exhibitors) when PHOTO_AUTOWRITE_ENABLED is on. Empty in identify-only mode.
   * These are the itemized sets OPE-205 §1's reply consumes.
   */
  autoWritten: AutoWriteOutcome[];
  /** Set when the gate is off — reported so a silent no-op is impossible. */
  disabledReason?: string;
}

export interface BoothPipelineEnv {
  AI?: VisionAi;
  VENDOR_ASSETS?: R2Bucket;
  /** OPE-6 gate. Must equal "true" or the pipeline no-ops. Default OFF. */
  PHOTO_VISION_ENABLED?: string;
  /**
   * OPE-204 Milestone B gate — INDEPENDENT of PHOTO_VISION_ENABLED. With vision
   * ON but this OFF, every booth (including high-confidence ones) is STAGED for
   * review — the identify-only measurement mode. Only when this is "true" do the
   * high-confidence booths auto-create vendors. Default OFF (customer-facing
   * writes; STOP-gated per OPE-6).
   */
  PHOTO_AUTOWRITE_ENABLED?: string;
  /** OPE-205 §3 — needed to hand general photos to the main app's pipeline. */
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/**
 * Identify + stage the booths in one fair-resolved photo email.
 *
 * Fail-soft throughout: a photo that can't be read, or a model that errors, is
 * skipped rather than throwing. This runs inside the inbound-email workflow and
 * must never sink an email over a bad JPEG.
 */
export async function runBoothPipeline(
  env: BoothPipelineEnv,
  db: Db,
  inboundEmailId: string,
  eventId: string,
  photos: PipelinePhoto[]
): Promise<BoothPipelineResult> {
  const empty: BoothPipelineResult = {
    examined: 0,
    staged: 0,
    skipped: 0,
    identifiedNames: [],
    galleryAttached: 0,
    galleryFailed: 0,
    autoWritten: [],
  };

  // OPE-6 gate — default OFF, and say so rather than no-op silently.
  if (env.PHOTO_VISION_ENABLED !== "true") {
    return {
      ...empty,
      disabledReason:
        'PHOTO_VISION_ENABLED is not "true" — booth identification is off. Nothing was examined.',
    };
  }
  if (!env.AI || !env.VENDOR_ASSETS) {
    return { ...empty, disabledReason: "AI or R2 binding unavailable" };
  }

  const bucket = env.VENDOR_ASSETS;
  const ai = env.AI;
  const results: Array<{ photo: PipelinePhoto; d: Disposition }> = [];

  for (const photo of photos.slice(0, MAX_PHOTOS_PER_EMAIL)) {
    try {
      const obj = await bucket.get(photo.key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const id = await identifyBooth(ai, bytes);
      results.push({ photo, d: disposition(id) });
    } catch {
      // One unreadable photo must not sink the batch.
      continue;
    }
  }

  // Milestone B split: when auto-write is ON, the high-confidence "write"
  // dispositions are auto-created and NOT staged (they need no review); the
  // "stage" ones still go to the review queue. When auto-write is OFF, every
  // non-skip disposition stages, exactly as Milestone A did (identify-only).
  const autoWriteOn = env.PHOTO_AUTOWRITE_ENABLED === "true";
  const nonSkip = results.filter((r) => r.d.action !== "skip");
  const skipped = results.length - nonSkip.length;

  const toAutoWrite = autoWriteOn ? nonSkip.filter((r) => r.d.action === "write") : [];
  const toStage = autoWriteOn ? nonSkip.filter((r) => r.d.action !== "write") : nonSkip;

  // Auto-write first (sequential, idempotent) — see auto-write.ts. Fail-soft:
  // its failures land in the outcomes, never thrown, so staging still runs.
  let autoWritten: AutoWriteOutcome[] = [];
  if (toAutoWrite.length > 0) {
    try {
      autoWritten = await autoWriteBooths(
        env,
        db,
        inboundEmailId,
        eventId,
        toAutoWrite.map((r) => ({
          photoKey: r.photo.key,
          photoName: r.photo.name,
          id: r.d.identification,
        }))
      );
    } catch {
      autoWritten = [];
    }
  }

  const now = new Date();
  for (const { photo, d } of toStage) {
    const id = d.identification;
    await db.insert(adminActions).values({
      action: BOOTH_PROPOSED_ACTION,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: inboundEmailId,
      payloadJson: JSON.stringify({
        event_id: eventId,
        photo_key: photo.key,
        photo_name: photo.name,
        business_name: id.businessName,
        website: id.website,
        products: id.products,
        confidence: id.confidence,
        rationale: id.rationale,
        // "write" here means Milestone B WOULD have auto-written this one.
        would_auto_write: d.action === "write",
        stage_reason: d.action === "stage" ? d.reason : null,
      }),
      // admin_actions.createdAt is notNull with NO default — Drizzle won't fill
      // it. Matches the roster-detect precedent (inbound-email.ts:813).
      createdAt: now,
    } as never);
  }

  if (toStage.length > 0) {
    await db
      .update(inboundEmails)
      .set({ flaggedForReview: 1 })
      .where(eq(inboundEmails.id, inboundEmailId));
  }

  // OPE-205 §3 — the "skip" bucket is general fair scenery, not a failure.
  // Attach it to the resolved event as gallery candidates (OPE-212's
  // event_photos). Fail-soft: this must never cost us the booth staging or the
  // fair match that already succeeded.
  let gallery = { attached: 0, failed: 0 };
  const generalPhotos = results.filter((r) => r.d.action === "skip").map((r) => r.photo);
  if (generalPhotos.length > 0) {
    try {
      gallery = await attachGeneralPhotos(env, eventId, generalPhotos);
    } catch {
      gallery = { attached: 0, failed: generalPhotos.length };
    }
  }

  return {
    examined: results.length,
    staged: toStage.length,
    skipped,
    identifiedNames: [
      ...toStage.map((r) => r.d.identification.businessName),
      ...autoWritten.map((a) => a.businessName),
    ].filter((n): n is string => Boolean(n)),
    galleryAttached: gallery.attached,
    galleryFailed: gallery.failed,
    autoWritten,
  };
}
