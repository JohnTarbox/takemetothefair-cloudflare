/**
 * OPE-227 increment A — the photo flywheel's PROPOSAL rail.
 *
 * For the most-seen imageless event pages, look at the organizer's own page,
 * take its og:image if it passes the existing quality gate, store the bytes on
 * our R2, and write a HOLD-FOR-REVIEW proposal. Nothing here writes
 * `events.image_url`.
 *
 * ## John's ruling (2026-09-01, reaffirmed 09-02), which this implements
 *
 *   "build scopes 1–3 in hold-for-review-only mode, owned-sources-only …
 *    hold every candidate for human review, auto-apply nothing. Never write a
 *    third-party URL into `image_url`."
 *
 * So the candidate engine is the one the manual `trigger_og_image_sweep` already
 * uses (`extractOgImage` → `urlLooksLikeJunk` → `acceptCandidateImage`), and the
 * difference is only what happens after the gate: the sweep's `apply=true`
 * writes `image_url` because an operator pressed the button; this runs
 * unattended, so it stops at a proposal. Approving one is increment B.
 *
 * ## Why proposals are `admin_actions` rows and not a table
 *
 * The ticket names a `photo_proposals` table that does not exist. Held photos
 * already live as `admin_actions` rows (`vendor.photo_proposed`,
 * `performer.photo_proposed`, `mcp-server/src/photo/booth-pipeline.ts`) and
 * `list_photo_proposals` reads them there. A hero proposal follows that shape,
 * so the review surface grows rather than forks.
 *
 * ## Why an ATTEMPT row too
 *
 * The daily loop takes the top of the demand ranking. Without a record of the
 * pages it already looked at and could not use (no og:image, aggregator source,
 * logo-sized image), it would re-fetch the same ten pages every day and never
 * reach the eleventh. Every event this touches leaves exactly one row: a
 * proposal or an attempt, and both hold it out of selection for
 * `RETRY_AFTER_DAYS`.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { adminActions, events, imageCoverageState } from "@/lib/db/schema";
import { extensionForContentType, extractOgImage, urlLooksLikeJunk } from "@/lib/og-image";
import type { AcceptResult, RejectResult } from "@/lib/og-image";
import { shouldIngestFromSource, type ClassificationMap } from "@/lib/url-classification";
import type { Db } from "@/lib/api/with-auth";

export const HERO_PROPOSED_ACTION = "event.hero_proposed";
export const HERO_ATTEMPT_ACTION = "event.hero_propose_attempt";
/** Written by increment B's approve/reject path; a proposal with one is closed. */
export const HERO_RESOLVED_ACTION = "event.hero_resolved";
export const HERO_PROPOSAL_CLASS = "event_hero";

/** A page we looked at is not looked at again for this long. */
export const RETRY_AFTER_DAYS = 30;
/**
 * Pages per call. Each costs one page fetch, one HEAD + Range probe, one image
 * GET and one R2 put — the same budget the manual sweep sizes at 10 against the
 * 30 s response window.
 */
export const MAX_PER_CALL = 10;

export interface HeroCandidate {
  id: string;
  slug: string;
  name: string;
  sourceUrl: string;
  imageUrl: string | null;
  demandImpressions: number;
  /**
   * OPE-746 self-heal — set when the event's current `image_url` is the URL the
   * rot sweep recorded as UNREACHABLE. The proposal then REPLACES that dead URL
   * (on approval only, and only while it is still the live value and still
   * dead); every other non-empty value stays untouchable.
   */
  deadImageUrl?: string | null;
  deadStatusCode?: number | null;
}

export type HeroOutcomeKind =
  | "proposed"
  | "skipped_has_image"
  | "skipped_aggregator"
  | "skipped_fetch_failed"
  | "skipped_no_meta"
  | "skipped_junk_url"
  | "skipped_quality_gate"
  | "skipped_download_failed"
  | "skipped_r2_failed";

export interface HeroOutcome {
  event_id: string;
  outcome: HeroOutcomeKind;
  source_url: string;
  candidate_url?: string;
  photo_key?: string;
  reason?: string;
}

/** Everything that touches the network or R2, injected so the rail is testable. */
export interface HeroProposalDeps {
  /** SSRF-guarded page fetch. null on any failure. */
  fetchHtml(url: string): Promise<string | null>;
  acceptCandidate(url: string): Promise<AcceptResult | RejectResult>;
  /** SSRF-guarded image GET. null on any failure. */
  downloadImage(url: string): Promise<ArrayBuffer | null>;
  putObject(
    key: string,
    bytes: ArrayBuffer,
    contentType: string,
    metadata: Record<string, string>
  ): Promise<void>;
  now(): Date;
}

const CDN_BASE = "https://cdn.meetmeatthefair.com";

/**
 * The demand-ranked imageless event pages that have an owned-looking source and
 * nothing already in flight.
 *
 * Reads `image_coverage_state` (the OPE-225 scan's ranking) joined to `events`,
 * so the ranking and the live row are checked together: a page imaged since the
 * last scan is excluded here rather than proposed over.
 */
export async function selectHeroCandidates(
  db: Db,
  limit: number,
  now: Date
): Promise<HeroCandidate[]> {
  const cutoffSec = Math.floor(now.getTime() / 1000) - RETRY_AFTER_DAYS * 86_400;
  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      sourceUrl: events.sourceUrl,
      imageUrl: events.imageUrl,
      demandImpressions: imageCoverageState.demandImpressions,
      urlHealth: imageCoverageState.urlHealth,
      coverageImageUrl: imageCoverageState.imageUrl,
      deadStatusCode: imageCoverageState.urlStatusCode,
    })
    .from(imageCoverageState)
    .innerJoin(events, eq(events.id, imageCoverageState.entityId))
    .where(
      and(
        eq(imageCoverageState.entityType, "EVENT"),
        eq(events.status, "APPROVED"),
        sql`${events.mergedInto} IS NULL`,
        // Either an empty slot, or (OPE-746 self-heal) a slot whose live value
        // is exactly the URL the rot sweep found dead. Keyed on equality with
        // the swept URL, so an image changed since the sweep is not a candidate.
        or(
          and(
            eq(imageCoverageState.hasImage, false),
            sql`TRIM(IFNULL(${events.imageUrl}, '')) = ''`
          ),
          and(
            eq(imageCoverageState.urlHealth, "UNREACHABLE"),
            sql`${events.imageUrl} = ${imageCoverageState.imageUrl}`
          )
        ),
        sql`TRIM(IFNULL(${events.sourceUrl}, '')) != ''`,
        // Recently looked at, whatever the result.
        sql`NOT EXISTS (
          SELECT 1 FROM ${adminActions} a
          WHERE a.target_type = 'event' AND a.target_id = ${events.id}
            AND a.action IN (${HERO_PROPOSED_ACTION}, ${HERO_ATTEMPT_ACTION})
            AND a.created_at >= ${cutoffSec}
        )`,
        // Any proposal still awaiting a decision, however old: never stack a
        // second one on top of it.
        sql`NOT EXISTS (
          SELECT 1 FROM ${adminActions} p
          WHERE p.target_type = 'event' AND p.target_id = ${events.id}
            AND p.action = ${HERO_PROPOSED_ACTION}
            AND NOT EXISTS (
              SELECT 1 FROM ${adminActions} r
              WHERE r.action = ${HERO_RESOLVED_ACTION}
                AND r.target_type = 'admin_action' AND r.target_id = p.id
            )
        )`
      )
    )
    .orderBy(desc(imageCoverageState.demandImpressions), events.id)
    .limit(Math.max(0, Math.min(limit, MAX_PER_CALL)));

  return rows.map(({ urlHealth, coverageImageUrl, deadStatusCode, ...r }) => {
    const dead =
      urlHealth === "UNREACHABLE" && coverageImageUrl != null && coverageImageUrl === r.imageUrl;
    return {
      ...r,
      sourceUrl: r.sourceUrl ?? "",
      deadImageUrl: dead ? coverageImageUrl : null,
      deadStatusCode: dead ? deadStatusCode : null,
    };
  });
}

/**
 * Look at each candidate's own page and either stage a proposal or record the
 * attempt. Returns one outcome per candidate, and writes one `admin_actions`
 * row per candidate — never more, never none.
 */
export async function proposeEventHeroes(
  db: Db,
  deps: HeroProposalDeps,
  candidates: HeroCandidate[],
  classMap: ClassificationMap,
  actorId: string
): Promise<HeroOutcome[]> {
  const outcomes: HeroOutcome[] = [];
  const rows: Array<typeof adminActions.$inferInsert> = [];
  const createdAt = deps.now();

  const attempt = (
    c: HeroCandidate,
    outcome: Exclude<HeroOutcomeKind, "proposed">,
    reason?: string,
    candidateUrl?: string
  ) => {
    outcomes.push({
      event_id: c.id,
      outcome,
      source_url: c.sourceUrl,
      ...(candidateUrl ? { candidate_url: candidateUrl } : {}),
      ...(reason ? { reason } : {}),
    });
    rows.push({
      id: crypto.randomUUID(),
      action: HERO_ATTEMPT_ACTION,
      actorUserId: null,
      targetType: "event",
      targetId: c.id,
      payloadJson: JSON.stringify({
        outcome,
        source_url: c.sourceUrl,
        candidate_url: candidateUrl ?? null,
        reason: reason ?? null,
        actor: actorId,
      }),
      createdAt,
    });
  };

  for (const c of candidates) {
    // Re-check the live value: the selection's snapshot can be seconds old, and
    // "never overwrite an existing hero" is the rule that must not race.
    // Keyed on EMPTY, not on `classifyImageHost(...) === "invalid"`: that verdict
    // also covers a malformed non-empty value, and a malformed value is still
    // somebody's value — this rail only ever fills an empty slot.
    //
    // OPE-746 — the one exception is the exact URL the rot sweep found dead:
    // that value is broken on the page already, and the proposal records it so
    // approval can compare-and-swap against it (see hero-resolve.ts).
    const current = (c.imageUrl ?? "").trim();
    if (current !== "" && current !== (c.deadImageUrl ?? "").trim()) {
      attempt(c, "skipped_has_image", c.imageUrl ?? "");
      continue;
    }
    if (!shouldIngestFromSource(c.sourceUrl, classMap)) {
      attempt(c, "skipped_aggregator");
      continue;
    }
    const html = await deps.fetchHtml(c.sourceUrl);
    if (!html) {
      attempt(c, "skipped_fetch_failed");
      continue;
    }
    const candidate = extractOgImage(html, c.sourceUrl);
    if (!candidate) {
      attempt(c, "skipped_no_meta", "no og:image or twitter:image");
      continue;
    }
    if (urlLooksLikeJunk(candidate.url)) {
      attempt(c, "skipped_junk_url", undefined, candidate.url);
      continue;
    }
    const gate = await deps.acceptCandidate(candidate.url);
    if (!gate.ok) {
      attempt(
        c,
        "skipped_quality_gate",
        `${gate.reason}${gate.detail ? `: ${gate.detail}` : ""}`,
        candidate.url
      );
      continue;
    }
    const ext = extensionForContentType(gate.contentType);
    if (!ext) {
      attempt(c, "skipped_quality_gate", `no_extension_for_${gate.contentType}`, candidate.url);
      continue;
    }
    const bytes = await deps.downloadImage(candidate.url);
    if (!bytes || bytes.byteLength === 0) {
      attempt(c, "skipped_download_failed", undefined, candidate.url);
      continue;
    }

    // Staged under `proposed/`, so an approved image is always re-run through
    // the upload pipeline (EXIF strip, WebP) rather than published as-is.
    const photoKey = `events/${c.id}/proposed/og-${createdAt.getTime()}.${ext}`;
    try {
      await deps.putObject(photoKey, bytes, gate.contentType, {
        source: "photo-flywheel",
        originUrl: candidate.url,
        ogSource: candidate.source,
      });
    } catch (e) {
      attempt(c, "skipped_r2_failed", e instanceof Error ? e.message : String(e), candidate.url);
      continue;
    }

    outcomes.push({
      event_id: c.id,
      outcome: "proposed",
      source_url: c.sourceUrl,
      candidate_url: candidate.url,
      photo_key: photoKey,
    });
    rows.push({
      id: crypto.randomUUID(),
      action: HERO_PROPOSED_ACTION,
      actorUserId: null,
      targetType: "event",
      targetId: c.id,
      payloadJson: JSON.stringify({
        photo_class: HERO_PROPOSAL_CLASS,
        event_id: c.id,
        event_slug: c.slug,
        event_name: c.name,
        photo_key: photoKey,
        photo_url: `${CDN_BASE}/${photoKey}`,
        candidate_url: candidate.url,
        og_source: candidate.source,
        source_url: c.sourceUrl,
        content_type: gate.contentType,
        bytes: bytes.byteLength,
        width: gate.dimensions?.width ?? null,
        height: gate.dimensions?.height ?? null,
        demand_impressions: c.demandImpressions,
        replaces_dead_url: current !== "" ? current : null,
        dead_status_code: current !== "" ? (c.deadStatusCode ?? null) : null,
        would_auto_write: false,
        actor: actorId,
      }),
      createdAt,
    });
  }

  if (rows.length > 0) {
    // One statement per row (7 bound params each, far under D1's 100), one
    // round trip for the lot.
    await db.batch(
      rows.map((r) => db.insert(adminActions).values(r)) as unknown as Parameters<Db["batch"]>[0]
    );
  }
  return outcomes;
}
