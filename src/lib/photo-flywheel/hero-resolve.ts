/**
 * OPE-227 increment B — a human decides a staged hero proposal.
 *
 * This is the ONLY place the photo flywheel writes `events.image_url`, and it
 * runs only on an explicit approve. Three rules, each pinned by a test:
 *
 *  1. **Fill-empty only.** If the event gained an image since the proposal was
 *     staged, approve refuses (409) and writes nothing — "never clobber an
 *     existing hero" is John's rule, and a stale proposal must not break it.
 *     OPE-746 exception: a self-heal proposal (`replaces_dead_url`) may replace
 *     that exact URL, and only if a fresh probe says it still does not load.
 *  2. **Through the upload pipeline.** The staged bytes are re-run through
 *     `runUploadPipeline` (magic-byte check, EXIF strip, WebP), exactly as a
 *     booth photo is on approve — the staged original is never published as-is.
 *  3. **Resolved once.** A proposal carries at most one `event.hero_resolved`
 *     row; a second decision is a 409, so "who decided and when" cannot be
 *     silently overwritten.
 */
import { and, eq } from "drizzle-orm";
import { adminActions, events } from "@/lib/db/schema";
import type { Db } from "@/lib/api/with-auth";
import type { PipelineResult, RunPipelineArgs } from "@/lib/upload-image-pipeline";
import { HERO_PROPOSED_ACTION, HERO_RESOLVED_ACTION } from "./hero-proposals";

export type HeroDecision = "approve" | "reject";

export interface HeroResolveDeps {
  /** Read the staged object's bytes and stored content type; null when missing. */
  readObject(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  runPipeline(args: Omit<RunPipelineArgs, "db" | "env">): Promise<PipelineResult>;
  /**
   * OPE-746 — re-probe a URL the rot sweep called dead. true = it loads now.
   * Required to approve a replacement: the sweep has flagged live images before
   * (8 of 13 on 2026-09-25), and a replacement over a working image is exactly
   * the clobber rule 1 forbids.
   */
  probeUrl?(url: string): Promise<boolean>;
  now(): Date;
}

export interface HeroResolveInput {
  proposalId: string;
  decision: HeroDecision;
  actorId: string | null;
  note?: string | null;
}

export type HeroResolveResult =
  | { status: 200; body: { ok: true; resolution: "approved"; event_id: string; image_url: string } }
  | { status: 200; body: { ok: true; resolution: "rejected"; event_id: string } }
  | { status: 404 | 409 | 422 | 502; body: { ok: false; error: string; [k: string]: unknown } };

interface StagedPayload {
  event_id?: string;
  photo_key?: string;
  content_type?: string;
  replaces_dead_url?: string | null;
}

export async function resolveHeroProposal(
  db: Db,
  deps: HeroResolveDeps,
  input: HeroResolveInput
): Promise<HeroResolveResult> {
  const [proposal] = await db
    .select({
      id: adminActions.id,
      targetId: adminActions.targetId,
      payloadJson: adminActions.payloadJson,
    })
    .from(adminActions)
    .where(
      and(eq(adminActions.id, input.proposalId), eq(adminActions.action, HERO_PROPOSED_ACTION))
    )
    .limit(1);
  if (!proposal) {
    return { status: 404, body: { ok: false, error: "No hero proposal with that id." } };
  }

  const [already] = await db
    .select({ id: adminActions.id, payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, HERO_RESOLVED_ACTION),
        eq(adminActions.targetType, "admin_action"),
        eq(adminActions.targetId, proposal.id)
      )
    )
    .limit(1);
  if (already) {
    return {
      status: 409,
      body: { ok: false, error: "Proposal already resolved.", already_resolved: true },
    };
  }

  let payload: StagedPayload = {};
  try {
    payload = JSON.parse(proposal.payloadJson ?? "{}") as StagedPayload;
  } catch {
    /* handled by the field checks below */
  }
  const eventId = payload.event_id ?? proposal.targetId;

  const record = async (resolution: "approved" | "rejected", extra: Record<string, unknown>) => {
    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action: HERO_RESOLVED_ACTION,
      actorUserId: input.actorId,
      targetType: "admin_action",
      targetId: proposal.id,
      payloadJson: JSON.stringify({
        resolution,
        event_id: eventId,
        photo_key: payload.photo_key ?? null,
        note: input.note ?? null,
        ...extra,
      }),
      createdAt: deps.now(),
    });
  };

  if (input.decision === "reject") {
    await record("rejected", {});
    return { status: 200, body: { ok: true, resolution: "rejected", event_id: eventId } };
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  if (!payload.photo_key) {
    return { status: 422, body: { ok: false, error: "Proposal carries no staged photo_key." } };
  }
  const [event] = await db
    .select({ id: events.id, imageUrl: events.imageUrl })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) {
    return { status: 404, body: { ok: false, error: `Event not found: ${eventId}` } };
  }
  const current = (event.imageUrl ?? "").trim();
  const deadUrl = (payload.replaces_dead_url ?? "").trim();
  // OPE-746 — a self-heal proposal may replace exactly the URL it was staged
  // against, and only while that URL is still dead. Anything else is rule 1.
  const replacingDead = current !== "" && deadUrl !== "" && current === deadUrl;
  if (replacingDead) {
    const loadsNow = deps.probeUrl ? await deps.probeUrl(current) : true;
    if (loadsNow) {
      return {
        status: 409,
        body: {
          ok: false,
          error: deps.probeUrl
            ? "The image this proposal would replace loads now, so it is not dead. Reject this proposal instead."
            : "Cannot confirm the current image is still dead (no probe available); refusing to overwrite it.",
          current_image_url: event.imageUrl,
        },
      };
    }
  }
  if (current !== "" && !replacingDead) {
    // Left UNRESOLVED on purpose: the operator should see why and reject it,
    // rather than have a decision recorded that nobody made.
    return {
      status: 409,
      body: {
        ok: false,
        error:
          "The event already has an image; approving would overwrite it. Reject this proposal instead.",
        current_image_url: event.imageUrl,
      },
    };
  }

  const staged = await deps.readObject(payload.photo_key);
  if (!staged) {
    return {
      status: 422,
      body: { ok: false, error: `Staged object is missing from R2: ${payload.photo_key}` },
    };
  }

  const pipe = await deps.runPipeline({
    bytes: staged.bytes,
    declaredType: staged.contentType || payload.content_type || "image/jpeg",
    fileName: `hero-${eventId}`,
    targetType: "event",
    targetId: eventId,
    caption: null,
    actorId: input.actorId ?? "system",
    uploadSource: "photo-flywheel-approve",
  });
  if (!pipe.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        error: `Upload pipeline refused the image: ${pipe.body.error}`,
        pipeline_status: pipe.status,
      },
    };
  }

  await record("approved", { image_url: pipe.body.url });
  return {
    status: 200,
    body: { ok: true, resolution: "approved", event_id: eventId, image_url: pipe.body.url },
  };
}
