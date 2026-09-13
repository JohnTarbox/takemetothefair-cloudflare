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
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import {
  identifyBooth,
  disposition,
  unidentified,
  type BoothIdentification,
  type Disposition,
  type StageKind,
  type VisionAi,
} from "./vision.js";
import { attachGeneralPhotos } from "./general-photos.js";
import { autoWriteBooths, type AutoWriteOutcome } from "./auto-write.js";
import { matchRosterPerformer, resolvePerformerPhoto } from "./performer-photos.js";

/** Audit action for a staged booth identification. */
export const BOOTH_PROPOSED_ACTION = "vendor.photo_proposed";
/** OPE-969 — a performer photo held for review (unnamed, unmatched, off-roster, or a child). */
export const PERFORMER_PROPOSED_ACTION = "performer.photo_proposed";
/** OPE-969 — a performer photo matched to an appearance already on the lineup. Nothing created. */
export const PERFORMER_CONFIRMED_ACTION = "performer.photo_confirmed";
/**
 * OPE-978 — a scenery photo attached to the event gallery. Before this the
 * gallery path wrote no decision row, so a photo classified as scenery was
 * indistinguishable from one that vanished: two of the 2026-09-12 New Gloucester
 * emails read "0 proposals, 0 failures" while their photos sat in the gallery.
 */
export const GALLERY_ATTACHED_ACTION = "photo.gallery_attached";
/** OPE-969 — a sign whose owner is not the subject. Recorded; nothing else written. */
export const SIGNAGE_RECORDED_ACTION = "photo.signage_not_presence";

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
  /** BOOTH identifications staged for review (needs a human). */
  staged: number;
  /** OPE-969 — performer photos staged for review. Counted apart from booths so
   *  the reply's booth count means booths. */
  performerStaged: number;
  /** OPE-969 — performer photos matched to an appearance already on the event. */
  performersConfirmed: Array<{ performerId: string; performerName: string; photoName: string }>;
  /** OPE-969 — signage-not-presence outcomes recorded (no proposal, no write). */
  signageRecorded: number;
  /** General (non-booth) scenery — the input to the gallery attach below. */
  skipped: number;
  /** Business names staged OR auto-written, for the reply. */
  identifiedNames: string[];
  /** OPE-205 §3 — general photos attached to the event as gallery candidates. */
  galleryAttached: number;
  /** General photos we tried but couldn't attach. Reported, never swallowed. */
  galleryFailed: number;
  /** OPE-469 — true when nothing was written. Absent on a live run. */
  dryRun?: boolean;
  /**
   * OPE-469 — business names auto-write WOULD have created, had this not been a
   * dry run. Distinct from `identifiedNames`, which on a live run covers both
   * staged and auto-written; here the two are kept apart so a replay can say
   * which path each photo was heading for.
   */
  wouldAutoWrite?: string[];
  /**
   * OPE-204 Milestone B — booths auto-written (created/linked as CONFIRMED
   * exhibitors) when PHOTO_AUTOWRITE_ENABLED is on. Empty in identify-only mode.
   * These are the itemized sets OPE-205 §1's reply consumes.
   */
  autoWritten: AutoWriteOutcome[];
  /** Set when the gate is off — reported so a silent no-op is impossible. */
  disabledReason?: string;
  /**
   * OPE-403 follow-up — per-photo vision failure reasons, when the model
   * produced nothing usable. Empty when every photo identified cleanly.
   *
   * The gate returning a `disabledReason` covers "vision never ran". This
   * covers the other half: vision ran and failed, which previously surfaced
   * only as `confidence: 0` with an unactionable rationale string.
   */
  visionFailures: string[];
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
export interface BoothPipelineOptions {
  /**
   * OPE-469 — classify without writing anything.
   *
   * Everything above the write points is already read-only: an R2 read and a
   * vision call per photo. `dryRun` stops the function there and reports what
   * the write half WOULD have done, so a stored attachment can be replayed as a
   * test without staging a booth, attaching a gallery photo, or flipping
   * `flagged_for_review` on a live row.
   *
   * It is a real exercise of the pipeline, not a simulation of one — the same
   * bytes, the same model, the same dispositions. Only the writes are withheld.
   */
  dryRun?: boolean;
}

export async function runBoothPipeline(
  env: BoothPipelineEnv,
  db: Db,
  inboundEmailId: string,
  eventId: string,
  photos: PipelinePhoto[],
  options: BoothPipelineOptions = {}
): Promise<BoothPipelineResult> {
  const empty: BoothPipelineResult = {
    examined: 0,
    staged: 0,
    performerStaged: 0,
    performersConfirmed: [],
    signageRecorded: 0,
    skipped: 0,
    identifiedNames: [],
    galleryAttached: 0,
    galleryFailed: 0,
    autoWritten: [],
    visionFailures: [],
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
    // OPE-978 — a photo that cannot be read or identified still gets a
    // disposition: an `unclear` stage carrying WHY. Both branches below used to
    // `continue`, which dropped the photo with no row and no reason.
    try {
      const obj = await bucket.get(photo.key);
      if (!obj) {
        results.push({ photo, d: disposition(unidentified(`r2-object-missing key=${photo.key}`)) });
        continue;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const id = await identifyBooth(ai, bytes);
      results.push({ photo, d: disposition(id) });
    } catch (e) {
      // One unreadable photo must not sink the batch — and must not vanish.
      results.push({
        photo,
        d: disposition(
          unidentified(`pipeline-threw: ${e instanceof Error ? e.message : String(e)}`)
        ),
      });
    }
  }

  // OPE-969 — resolve performer photos against the performer table and THIS
  // event's roster. Reads only, so it runs before the dry-run boundary and a
  // replay reports the same outcome a live run would act on.
  type Staged = {
    photo: PipelinePhoto;
    id: BoothIdentification;
    action: string;
    stageKind: StageKind | null;
    reason: string | null;
    wouldAutoWrite: boolean;
    performer?: { id: string | null; name: string | null; appearancesOnEvent: number };
    /** Set when the model said booth and the roster said performer. */
    reclassifiedFrom?: "booth";
  };
  const autoWriteOn = env.PHOTO_AUTOWRITE_ENABLED === "true";
  const staged: Staged[] = [];
  const confirmed: Array<{
    photo: PipelinePhoto;
    performerId: string;
    performerName: string;
    appearancesOnEvent: number;
    reclassifiedFrom?: "booth";
  }> = [];
  const toAutoWrite: typeof results = [];

  for (const r of results) {
    let d: Disposition = r.d;
    let reclassifiedFrom: "booth" | undefined;

    // OPE-969 — ROSTER FIRST, whatever the model called the photo. Measured on
    // the Waterford specimen itself: the Axe Women truck came back as a BOOTH
    // named "AxeWomen" at confidence 1, which is a vendor proposal today and a
    // created vendor once auto-write is on. A booth name that matches an act
    // already on this event's lineup is that act.
    const boothName = d.identification.kind === "booth" ? d.identification.businessName : null;
    if (boothName && (d.action === "write" || d.action === "stage")) {
      try {
        if (await matchRosterPerformer(db, eventId, boothName)) {
          d = {
            action: "performer",
            identification: {
              ...d.identification,
              kind: "performer",
              performerName: boothName,
              businessName: null,
              products: [],
            },
          };
          reclassifiedFrom = "booth";
        }
      } catch (e) {
        // The check that keeps an act out of the vendor table failed, so this
        // photo must not auto-write on the strength of not having been checked.
        if (d.action === "write") {
          d = {
            action: "stage",
            identification: d.identification,
            reason:
              `roster check failed — not auto-written: ${e instanceof Error ? e.message : String(e)}`.slice(
                0,
                200
              ),
            stageKind: "booth_roster_check_failed",
          };
        }
      }
    }

    if (d.action === "write") {
      // Milestone B split: auto-written when the gate is on; otherwise staged
      // exactly as Milestone A did, marked as a would-have-written.
      if (autoWriteOn) toAutoWrite.push(r);
      else
        staged.push({
          photo: r.photo,
          id: d.identification,
          action: BOOTH_PROPOSED_ACTION,
          stageKind: null,
          reason: null,
          wouldAutoWrite: true,
        });
    } else if (d.action === "stage") {
      staged.push({
        photo: r.photo,
        id: d.identification,
        action:
          d.identification.kind === "performer" ? PERFORMER_PROPOSED_ACTION : BOOTH_PROPOSED_ACTION,
        stageKind: d.stageKind,
        reason: d.reason,
        wouldAutoWrite: false,
      });
    } else if (d.action === "performer") {
      try {
        const res = await resolvePerformerPhoto(db, eventId, d.identification);
        if (res.outcome === "confirmed") {
          confirmed.push({
            photo: r.photo,
            performerId: res.performerId,
            performerName: res.performerName,
            appearancesOnEvent: res.appearancesOnEvent,
            reclassifiedFrom,
          });
        } else {
          staged.push({
            photo: r.photo,
            id: d.identification,
            action: PERFORMER_PROPOSED_ACTION,
            stageKind: res.stageKind,
            reason: res.reason,
            wouldAutoWrite: false,
            performer: {
              id: res.performerId,
              name: res.performerName,
              appearancesOnEvent: res.appearancesOnEvent,
            },
            reclassifiedFrom,
          });
        }
      } catch (e) {
        // Fail-soft like every photo step: a lookup fault stages, never writes.
        staged.push({
          photo: r.photo,
          id: d.identification,
          action: PERFORMER_PROPOSED_ACTION,
          stageKind: "performer_unmatched",
          reason: `performer lookup failed: ${e instanceof Error ? e.message : String(e)}`.slice(
            0,
            200
          ),
          wouldAutoWrite: false,
        });
      }
    }
  }

  const scenery = results.filter((r) => r.d.action === "skip");
  const signage = results.filter((r) => r.d.action === "record");
  const boothStaged = staged.filter((x) => x.action === BOOTH_PROPOSED_ACTION);
  const performerStaged = staged.length - boothStaged.length;
  const skipped = scenery.length;
  const galleryPhotos = [...scenery.map((r) => r.photo), ...confirmed.map((c) => c.photo)];
  const performersConfirmed = confirmed.map((c) => ({
    performerId: c.performerId,
    performerName: c.performerName,
    photoName: c.photo.name,
  }));
  const visionFailures = results
    .map((r) => r.d.identification.failureReason)
    .filter((f): f is string => Boolean(f));

  // OPE-469 — the dry-run boundary. Everything above this line reads (R2 +
  // vision + the performer lookup); everything below writes (auto-write,
  // admin_actions, flagged_for_review, gallery attach). Returning here is what
  // makes a replay safe to run against a live row.
  //
  // The counts reported are what the write half WOULD produce, derived from the
  // same buckets the writes use — not re-derived, so the report cannot drift
  // from the behaviour it predicts.
  if (options.dryRun) {
    return {
      examined: results.length,
      staged: boothStaged.length,
      performerStaged,
      performersConfirmed,
      signageRecorded: signage.length,
      skipped,
      identifiedNames: boothStaged
        .map((x) => x.id.businessName)
        .concat(toAutoWrite.map((r) => r.d.identification.businessName ?? ""))
        .filter((n): n is string => Boolean(n)),
      // Reported as "would attach". `attachGeneralPhotos` can still fail on a
      // real run, so this is an upper bound rather than a promise — which is
      // why a replay compares against the recorded outcome instead of asserting
      // equality with it.
      galleryAttached: galleryPhotos.length,
      galleryFailed: 0,
      autoWritten: [],
      visionFailures,
      dryRun: true,
      wouldAutoWrite: toAutoWrite
        .map((r) => r.d.identification.businessName)
        .filter((n): n is string => Boolean(n)),
    };
  }

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
  // OPE-969 — every audit row below is written once per (action, email, photo).
  // A replayed email re-classifies the same photo; it must not re-propose it.
  const record = async (action: string, photo: PipelinePhoto, payload: Record<string, unknown>) => {
    if (await alreadyLogged(db, action, inboundEmailId, photo.key)) return;
    await db.insert(adminActions).values({
      action,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: inboundEmailId,
      payloadJson: JSON.stringify({
        event_id: eventId,
        photo_key: photo.key,
        photo_name: photo.name,
        ...payload,
      }),
      // admin_actions.createdAt is notNull with NO default — Drizzle won't fill
      // it. Matches the roster-detect precedent (inbound-email.ts:813).
      createdAt: now,
    } as never);
  };

  for (const x of staged) {
    const id = x.id;
    await record(x.action, x.photo, {
      // OPE-969 — what the photo IS, and a closed reason vocabulary, so "a
      // booth whose name is unreadable" and "not a booth" never share a label.
      photo_class: id.kind,
      stage_kind: x.stageKind,
      business_name: id.businessName,
      performer_name: id.performerName,
      ...(x.performer
        ? {
            performer_id: x.performer.id,
            matched_performer_name: x.performer.name,
            appearances_on_event: x.performer.appearancesOnEvent,
          }
        : {}),
      website: id.website,
      products: id.products,
      confidence: id.confidence,
      rationale: id.rationale,
      identifiable_minor: id.identifiableMinor,
      // OPE-403 follow-up — which of the five UNIDENTIFIED paths produced
      // this, when it was a failure. Absent on a successful identification.
      failure_reason: id.failureReason ?? null,
      // Milestone B WOULD have auto-written this one.
      would_auto_write: x.wouldAutoWrite,
      reclassified_from: x.reclassifiedFrom ?? null,
      stage_reason: x.reason,
    });
  }

  for (const c of confirmed) {
    await record(PERFORMER_CONFIRMED_ACTION, c.photo, {
      photo_class: "performer",
      performer_id: c.performerId,
      performer_name: c.performerName,
      appearances_on_event: c.appearancesOnEvent,
      reclassified_from: c.reclassifiedFrom ?? null,
      // Recorded, never acted on: no path sets a hero from a photo.
      hero_candidate: true,
    });
  }

  for (const r of signage) {
    const id = r.d.identification;
    await record(SIGNAGE_RECORDED_ACTION, r.photo, {
      photo_class: "signage",
      sign_text: id.signText,
      confidence: id.confidence,
      rationale: id.rationale,
    });
  }

  if (staged.length > 0) {
    await db
      .update(inboundEmails)
      .set({ flaggedForReview: 1 })
      .where(eq(inboundEmails.id, inboundEmailId));
  }

  // OPE-205 §3 — scenery, plus OPE-969's confirmed performer photos, go to the
  // resolved event's gallery. Re-attaching the same bytes converges on the
  // existing row (OPE-686 content digest), so a replay does not duplicate it.
  // Fail-soft: this must never cost us the staging or the fair match.
  const gallery = { attached: 0, failed: 0 };
  const confirmedKeys = new Set(confirmed.map((c) => c.photo.key));
  for (const p of galleryPhotos) {
    // One photo at a time so each gets its own outcome (≤5 per email).
    let one: { attached: number; failed: number; failures?: string[]; disabledReason?: string };
    try {
      one = await attachGeneralPhotos(env, eventId, [p]);
    } catch (e) {
      one = {
        attached: 0,
        failed: 1,
        failures: [`threw:${e instanceof Error ? e.message : String(e)}`],
      };
    }
    gallery.attached += one.attached;
    gallery.failed += one.failed;
    // OPE-978 — scenery's decision row. A confirmed performer photo already has
    // its own (performer.photo_confirmed), so it is not recorded twice.
    if (!confirmedKeys.has(p.key)) {
      await record(GALLERY_ATTACHED_ACTION, p, {
        photo_class: "scenery",
        attached: one.attached > 0,
        failure: one.failures?.[0] ?? one.disabledReason ?? null,
      });
    }
  }

  return {
    examined: results.length,
    staged: boothStaged.length,
    performerStaged,
    performersConfirmed,
    signageRecorded: signage.length,
    skipped,
    identifiedNames: [
      ...boothStaged.map((x) => x.id.businessName),
      ...autoWritten.map((a) => a.businessName),
    ].filter((n): n is string => Boolean(n)),
    galleryAttached: gallery.attached,
    galleryFailed: gallery.failed,
    autoWritten,
    // Named per photo so one bad frame in a batch is distinguishable from a
    // systemic failure (e.g. every photo returning `ai-run-threw`).
    visionFailures,
  };
}

/** OPE-969 — has this exact (action, email, photo) already been recorded? */
async function alreadyLogged(
  db: Db,
  action: string,
  inboundEmailId: string,
  photoKey: string
): Promise<boolean> {
  const rows = await db
    .select({ id: adminActions.id })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, action),
        eq(adminActions.targetId, inboundEmailId),
        sql`json_extract(${adminActions.payloadJson}, '$.photo_key') = ${photoKey}`
      )
    )
    .limit(1);
  return rows.length > 0;
}
