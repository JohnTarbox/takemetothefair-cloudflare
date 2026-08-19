/**
 * OPE-469 — re-feed a stored inbound attachment through the photo pipeline.
 *
 * ## Why this exists
 *
 * Every inbound attachment is retained — 87 across 61 emails from 7 senders
 * since 2026-05-29, keys in `inbound_emails.attachment_refs` — and none of it
 * could be re-processed. The two tools that touch stored emails are both
 * *repair* tools that take the answer as input: `resolve_held_photos` attaches
 * photos to a fair you name, and `salvage_inbound_email` links an email to
 * events you already created by hand. Neither re-runs extraction, so neither
 * exercises the thing under test.
 *
 * The consequence was that the only end-to-end test of the photo lane was for
 * an operator to physically attend a fair and take a picture. OPE-403 sat with
 * an unproven acceptance criterion for two days waiting on exactly that, while
 * an already-passing specimen sat unexamined in the database.
 *
 * ## Dry-run is the default, and it is a real run
 *
 * `runBoothPipeline`'s read half — an R2 read and a vision call per photo —
 * was already separable from its write half. `dryRun` stops it at that
 * boundary. So a replay uses the same bytes, the same model and the same
 * dispositions as a live inbound; only the writes are withheld.
 *
 * That distinction matters for the ticket's acceptance: a replay that
 * *simulated* the pipeline could not reproduce a known-correct past result, and
 * a tool that cannot reproduce a known result is not a test instrument.
 *
 * ## Three things it must never do
 *
 * 1. **Write, unless explicitly told to.** This operates on live rows; a replay
 *    that wrote by default would turn a test into a data-corruption vector.
 * 2. **Send mail.** Not gated — structurally impossible. The handler returns a
 *    `replyKind` that the workflow acts on; this never produces one and never
 *    returns into the workflow, so there is no path from here to an outbound
 *    send. See the test that asserts it, since "no path exists" is exactly the
 *    kind of claim that rots.
 * 3. **Disturb the fingerprint.** The five 2026-08-15 emails carry
 *    `photos_stored = NULL` deliberately — NULL means "never tried", 0 means
 *    "tried and stored nothing", and only the second is a defect. A dry run
 *    writes nothing at all, so the distinction survives being tested.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { inboundEmails } from "../schema.js";
import {
  parseRefs,
  imageRefs,
  readExif,
  resolvePhotoEvent,
  type AttachmentRef,
} from "../email-handlers/photo-intake.js";
import { runBoothPipeline, type BoothPipelineResult } from "./booth-pipeline.js";
import type { HandlerEnv } from "../email-handlers/types.js";
import type { BoothPipelineEnv } from "./booth-pipeline.js";
import { parsePlusSegment } from "../email-intents.js";

export type ReplayEnv = HandlerEnv & BoothPipelineEnv;

export interface ReplayOptions {
  inboundEmailId: string;
  /** 0-based index into the IMAGE attachments. Omit to replay all of them. */
  attachmentIndex?: number;
  /**
   * Write the outcome for real. Requires `REPLAY_COMMIT_ENABLED="true"` in the
   * environment as well — see `commitBlockedReason`.
   */
  commit?: boolean;
}

export interface ReplayReport {
  inboundEmailId: string;
  dryRun: boolean;
  /** Present when `commit: true` was asked for and refused, with the reason. */
  commitBlockedReason?: string;
  attachments: {
    total: number;
    images: number;
    /** How many were actually fed to the pipeline (1 when an index was given). */
    replayed: number;
    keys: string[];
  };
  resolution: {
    status: string;
    reason?: string;
    eventId?: string;
    eventName?: string;
    eventSlug?: string;
    method?: string;
    distanceMiles?: number;
    venueName?: string;
  };
  exif: { hasGps: boolean; takenOnLocalDate: string | null };
  /** Null when the fair did not resolve — the pipeline never runs in that case. */
  vision: BoothPipelineResult | null;
  /**
   * What the ORIGINAL run recorded for this email, read straight from the row.
   * The point of a replay is comparison, so the baseline travels with the
   * result rather than being looked up separately and possibly at a later time.
   */
  original: {
    photosStored: number | null;
    resultingEventId: string | null;
    replyKind: string | null;
    flaggedForReview: number | null;
  };
  /** Human-readable lines describing every write a committed run would perform. */
  wouldWrite: string[];
}

/** Whether an explicit commit is permitted in this environment. */
export function commitBlockedReason(env: { REPLAY_COMMIT_ENABLED?: string }): string | null {
  if (env.REPLAY_COMMIT_ENABLED === "true") return null;
  return (
    'REPLAY_COMMIT_ENABLED is not "true" — a committed replay writes to live rows ' +
    "(event_photos, admin_actions, inbound_emails.photos_stored) and is gated off by " +
    "default. The dry run below is complete and wrote nothing."
  );
}

/**
 * Describe, in plain sentences, what committing this replay would change.
 *
 * Written from the dry-run result rather than from the pipeline's source, so it
 * says what WOULD happen to these photos, not what the pipeline does in general.
 */
function describeWrites(vision: BoothPipelineResult | null, eventId?: string): string[] {
  if (!vision) {
    return ["Nothing — the fair did not resolve, so the pipeline would not run."];
  }
  if (vision.disabledReason) {
    return [`Nothing — ${vision.disabledReason}`];
  }

  const lines: string[] = [];
  if (vision.staged > 0) {
    lines.push(
      `${vision.staged} admin_actions row(s) staging a booth identification for review` +
        (vision.identifiedNames.length ? ` — ${vision.identifiedNames.join(", ")}` : "")
    );
    lines.push("inbound_emails.flagged_for_review = 1");
  }
  if (vision.wouldAutoWrite?.length) {
    lines.push(
      `${vision.wouldAutoWrite.length} vendor(s) auto-written: ${vision.wouldAutoWrite.join(", ")}`
    );
  }
  if (vision.galleryAttached > 0) {
    lines.push(
      `${vision.galleryAttached} general photo(s) attached to event ${eventId ?? "?"} as event_photos gallery candidates`
    );
  }
  lines.push(`inbound_emails.photos_stored would be set (currently the original value)`);
  return lines.length > 0 ? lines : ["Nothing — every photo was skipped."];
}

/**
 * Replay one stored inbound email's attachments through the photo pipeline.
 *
 * Dry-run unless BOTH `commit: true` is passed AND the environment allows it.
 * Throws only when the email or its attachments cannot be found — an unresolved
 * fair or a disabled vision model is a RESULT, not an error, because those are
 * exactly the outcomes a replay is run to inspect.
 */
export async function replayInboundAttachment(
  env: ReplayEnv & { REPLAY_COMMIT_ENABLED?: string },
  db: Db,
  options: ReplayOptions
): Promise<ReplayReport> {
  const rows = await db
    .select({
      id: inboundEmails.id,
      subject: inboundEmails.subject,
      toAddress: inboundEmails.toAddress,
      attachmentRefs: inboundEmails.attachmentRefs,
      attachmentCount: inboundEmails.attachmentCount,
      photosStored: inboundEmails.photosStored,
      resultingEventId: inboundEmails.resultingEventId,
      replyKind: inboundEmails.replyKind,
      flaggedForReview: inboundEmails.flaggedForReview,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, options.inboundEmailId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`replay: inbound email ${options.inboundEmailId} not found`);

  const refs = parseRefs(row.attachmentRefs);
  const images = imageRefs(refs);
  if (images.length === 0) {
    throw new Error(
      `replay: inbound email ${options.inboundEmailId} has no image attachments ` +
        `(${refs.length} attachment ref(s) total)`
    );
  }

  let selected: AttachmentRef[] = images;
  if (options.attachmentIndex !== undefined) {
    const picked = images[options.attachmentIndex];
    if (!picked) {
      throw new Error(
        `replay: attachment_index ${options.attachmentIndex} out of range — ` +
          `this email has ${images.length} image attachment(s)`
      );
    }
    selected = [picked];
  }

  const blocked = options.commit ? commitBlockedReason(env) : null;
  const dryRun = !options.commit || blocked !== null;

  // Identical to the live handler's override precedence — plus-address, then a
  // slug or pasted /events/<slug> URL in the subject — reached through the same
  // exported resolver so the two cannot drift apart.
  const eventHint = parsePlusSegment(row.toAddress);
  const overrideSlugs = eventHint ? [eventHint] : [];

  const { resolution, exif } = await resolvePhotoEvent(
    db,
    overrideSlugs,
    () => readExif(env, selected),
    row.subject
  );

  let vision: BoothPipelineResult | null = null;
  if (resolution.status === "resolved") {
    vision = await runBoothPipeline(
      env,
      db,
      row.id,
      resolution.eventId,
      selected.map((r) => ({ key: r.key, name: r.name })),
      { dryRun }
    );
  }

  const report: ReplayReport = {
    inboundEmailId: row.id,
    dryRun,
    attachments: {
      total: refs.length,
      images: images.length,
      replayed: selected.length,
      keys: selected.map((r) => r.key),
    },
    resolution:
      resolution.status === "resolved"
        ? {
            status: resolution.status,
            eventId: resolution.eventId,
            eventName: resolution.eventName,
            eventSlug: resolution.eventSlug,
            method: resolution.method,
            distanceMiles: resolution.distanceMiles,
            venueName: resolution.venueName,
          }
        : { status: resolution.status, reason: (resolution as { reason?: string }).reason },
    exif: { hasGps: Boolean(exif.gps), takenOnLocalDate: exif.takenOnLocalDate ?? null },
    vision,
    original: {
      photosStored: row.photosStored ?? null,
      resultingEventId: row.resultingEventId ?? null,
      replyKind: row.replyKind ?? null,
      flaggedForReview: row.flaggedForReview ?? null,
    },
    wouldWrite: dryRun
      ? describeWrites(vision, resolution.status === "resolved" ? resolution.eventId : undefined)
      : [],
  };

  if (blocked) report.commitBlockedReason = blocked;
  return report;
}
