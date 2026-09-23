/**
 * OPE-325 (review bounce 2026-09-23) — keep the poster, cite it, offer it.
 *
 * The poster lane staged four PENDING events in August, and every one of them
 * had ZERO `event_data_citations` rows and a NULL `image_url`. The poster —
 * the only evidence any of those fields rested on — stayed an anonymous object
 * under `inbound-attachments/`, reachable from nothing on the event.
 *
 * Three steps, the same for a NEW PENDING event and for an EXISTING one the
 * poster resolved to (the enrich-not-create case):
 *
 *   1. ARCHIVE — copy the image to `events/<id>/posters/…` on our CDN, so the
 *      evidence lives under the event it supports and has a URL anyone can open.
 *   2. CITE — one citation per extracted field, `source_url` = that archived
 *      copy (the unfetchable-citation pattern: a poster has no page, so the
 *      archived image IS the source).
 *   3. OFFER — a HOLD-FOR-REVIEW hero proposal, only when the event has no
 *      image. Nothing here writes `events.image_url`; approving the proposal
 *      runs the upload pipeline (EXIF strip, resize) and fills an empty field
 *      only, which is the flywheel's rule and John's ("auto-apply nothing").
 *
 * Nothing here is public: citations are provenance (never rendered on an event
 * page, and this path never denormalises into `events`), and a proposal is a
 * queue row. So enriching an APPROVED event cannot change what a visitor sees,
 * which is what keeps OPE-204's "no public writes from an unmeasured
 * classifier" intact on the enrich path too.
 *
 * Every step is independent and fail-soft: a failed archive skips the cite and
 * the offer (both need the URL), but never the reply the sender is owed.
 */
import { and, eq } from "drizzle-orm";
import { adminActions, events } from "../schema.js";
import type { Db } from "../db.js";
import { recordSourceCitations } from "../email-handlers/pipeline-citations.js";
import { HERO_PROPOSED_ACTION } from "../tools/admin-hero-proposals.js";

export const POSTER_CDN_BASE = "https://cdn.meetmeatthefair.com";
/** Same class the flywheel writes, so `list_hero_proposals` shows it unchanged. */
const HERO_PROPOSAL_CLASS = "event_hero";

export interface PosterImageRef {
  key: string;
  name: string;
  mimeType: string;
}

/** Minimal R2 surface — lets a test hand in an in-memory bucket. */
export interface PosterBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<unknown | null>;
  put(
    key: string,
    body: ArrayBuffer,
    opts: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    }
  ): Promise<unknown>;
}

/**
 * Stable per (event, inbound message, filename): a Workflow retry or a second
 * poster in the same email maps to the same key, so archiving is idempotent.
 */
export function posterArchiveKey(eventId: string, inboundId: string, name: string): string {
  const safe =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "poster";
  return `events/${eventId}/posters/${inboundId.slice(0, 8)}-${safe}`;
}

export interface PosterEvidenceResult {
  archivedUrl: string | null;
  citationsInserted: number;
  citationReason: string | null;
  hero: "proposed" | "event_has_image" | "already_proposed" | "no_event" | "skipped";
  error?: string;
}

export async function attachPosterEvidence(
  deps: { bucket: PosterBucket | undefined; db: Db },
  args: {
    eventId: string;
    eventName: string | null;
    image: PosterImageRef;
    ocrText: string;
    inboundId: string;
    fromAddress: string;
    extracted: Parameters<typeof recordSourceCitations>[1]["extracted"];
  }
): Promise<PosterEvidenceResult> {
  const out: PosterEvidenceResult = {
    archivedUrl: null,
    citationsInserted: 0,
    citationReason: null,
    hero: "skipped",
  };
  if (!deps.bucket) return { ...out, error: "no VENDOR_ASSETS binding" };

  // 1. ARCHIVE
  const key = posterArchiveKey(args.eventId, args.inboundId, args.image.name);
  try {
    if (!(await deps.bucket.head(key))) {
      const src = await deps.bucket.get(args.image.key);
      if (!src) return { ...out, error: `poster object missing: ${args.image.key}` };
      await deps.bucket.put(key, await src.arrayBuffer(), {
        httpMetadata: { contentType: args.image.mimeType },
        customMetadata: {
          source: "photo-intake-poster",
          inboundEmailId: args.inboundId,
          originKey: args.image.key,
        },
      });
    }
  } catch (err) {
    return { ...out, error: `archive failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  out.archivedUrl = `${POSTER_CDN_BASE}/${key}`;

  // 2. CITE — the OCR text is the supporting text, so the OPE-457 guard can
  // refuse a date the poster never printed.
  try {
    const cited = await recordSourceCitations(deps.db, {
      eventId: args.eventId,
      extracted: args.extracted,
      source: { kind: "poster", url: out.archivedUrl, name: args.image.name },
      fromAddress: args.fromAddress,
      supportingText: args.ocrText,
    });
    out.citationsInserted = cited.inserted;
    out.citationReason = cited.reason;
  } catch (err) {
    out.citationReason = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 3. OFFER — only to an imageless event, and once per staged key.
  try {
    const [ev] = await deps.db
      .select({ id: events.id, slug: events.slug, imageUrl: events.imageUrl })
      .from(events)
      .where(eq(events.id, args.eventId))
      .limit(1);
    if (!ev) {
      out.hero = "no_event";
    } else if ((ev.imageUrl ?? "").trim() !== "") {
      out.hero = "event_has_image";
    } else {
      const prior = await deps.db
        .select({ payloadJson: adminActions.payloadJson })
        .from(adminActions)
        .where(
          and(
            eq(adminActions.action, HERO_PROPOSED_ACTION),
            eq(adminActions.targetId, args.eventId)
          )
        );
      if (prior.some((p) => (p.payloadJson ?? "").includes(`"photo_key":"${key}"`))) {
        out.hero = "already_proposed";
      } else {
        await deps.db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: HERO_PROPOSED_ACTION,
          actorUserId: null,
          targetType: "event",
          targetId: args.eventId,
          payloadJson: JSON.stringify({
            photo_class: HERO_PROPOSAL_CLASS,
            event_id: args.eventId,
            event_slug: ev.slug,
            event_name: args.eventName,
            photo_key: key,
            photo_url: out.archivedUrl,
            source_url: out.archivedUrl,
            og_source: "emailed-poster",
            content_type: args.image.mimeType,
            inbound_email_id: args.inboundId,
            would_auto_write: false,
            actor: "photo-intake-poster",
          }),
          createdAt: new Date(),
        });
        out.hero = "proposed";
      }
    }
  } catch (err) {
    out.error = `hero proposal failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return out;
}
