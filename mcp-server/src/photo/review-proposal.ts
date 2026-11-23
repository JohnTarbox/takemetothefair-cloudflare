/**
 * OPE-1704 — resolve one staged photo proposal: approve, reject, or close it as
 * already handled by hand.
 *
 * ## Why this exists
 *
 * Booth proposals have been staged since 2026-08-16, and by 2026-11-22 there
 * were 63 of them with no way to work the queue over MCP. The admin UI route
 * (`/api/admin/inbound-emails/[id]/booth-proposals/resolve`, OPE-205 §2) could
 * approve and reject, but only behind a browser session. Analysts cleared six
 * Makers Market booths by hand with `create_or_link_vendor` + an image upload,
 * and those six still read as staged, because nothing recorded the decision.
 *
 * ## The record
 *
 * A resolution is an `admin_actions` row, the SAME one the UI route writes:
 * `action='vendor.photo_resolved'`, `target_type='admin_action'`,
 * `target_id=<proposal id>`, `payload_json.resolution` ∈ approved | rejected |
 * already_handled. So a proposal resolved in the UI reads as resolved here and
 * vice versa, `repoint_photo_intake` already skips it, and no migration is
 * needed.
 *
 * ## Once only
 *
 * A second call on a resolved proposal writes nothing and returns the first
 * decision (`already_resolved: true`). The approve write tail is itself
 * idempotent (strict dedup + link upsert), so a double-click race at worst
 * leaves two resolution rows for one vendor link; the FIRST row is the one
 * every reader reports.
 *
 * ## Approve
 *
 * Booth proposals only. Creates or links the vendor through the shared
 * `createOrLinkVendor` with STRICT name dedup and the OPE-1694 domain match
 * (or links `vendor_id` directly), as EXHIBITOR / CONFIRMED on the proposal's
 * event. The photo becomes the vendor's logo only when it has none; otherwise
 * it is appended to the vendor's gallery. A logo is never overwritten, claimed
 * vendor or not. A human or analyst triggers this — nothing calls it
 * automatically; automatic writes stay behind PHOTO_AUTOWRITE_ENABLED.
 */
import { and, asc, eq } from "drizzle-orm";
import { createOrLinkVendor } from "@takemetothefair/vendor-linking";
import { adminActions, vendors } from "../schema.js";
import { recomputeVendorCompleteness, logEnrichment } from "../helpers.js";
import type { Db } from "../db.js";
import { BOOTH_PROPOSED_ACTION, PERFORMER_PROPOSED_ACTION } from "./booth-pipeline.js";
import { PHOTO_RESOLVED_ACTION } from "./repoint.js";
import { postBoothPhoto, type AutoWriteEnv } from "./auto-write.js";

export const PROPOSAL_DECISIONS = ["approve", "reject", "already_handled"] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

/** What `payload_json.resolution` holds for each decision. */
export const RESOLUTION_FOR: Record<ProposalDecision, ProposalResolution> = {
  approve: "approved",
  reject: "rejected",
  already_handled: "already_handled",
};
export type ProposalResolution = "approved" | "rejected" | "already_handled";

export interface ReviewProposalInput {
  proposalId: string;
  decision: ProposalDecision;
  /** Approve: overrides the name the model read (required when it read none). */
  businessName?: string | null;
  /** Approve: link this existing vendor instead of matching by name/domain. */
  vendorId?: string | null;
  note?: string | null;
  actorUserId: string | null;
}

export interface PriorResolution {
  resolution: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  payload: Record<string, unknown>;
}

export type ReviewProposalResult =
  | {
      ok: true;
      proposal_id: string;
      already_resolved: boolean;
      resolution: string | null;
      /** The decision row's payload — the prior one when `already_resolved`. */
      detail: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
      code?: "not_found" | "no_name" | "no_event" | "not_booth" | "domain_ambiguous";
      candidates?: Array<{ id: string; businessName: string }>;
    };

interface ProposalPayload {
  event_id?: string;
  photo_key?: string;
  business_name?: string | null;
  website?: string | null;
  products?: string[] | null;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  try {
    const p = JSON.parse(raw ?? "{}") as unknown;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The FIRST resolution row for a proposal, or null when it is still open. */
export async function findResolution(db: Db, proposalId: string): Promise<PriorResolution | null> {
  const [row] = await db
    .select({
      payloadJson: adminActions.payloadJson,
      createdAt: adminActions.createdAt,
      actorUserId: adminActions.actorUserId,
    })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, PHOTO_RESOLVED_ACTION),
        eq(adminActions.targetType, "admin_action"),
        eq(adminActions.targetId, proposalId)
      )
    )
    .orderBy(asc(adminActions.createdAt), asc(adminActions.id))
    .limit(1);
  if (!row) return null;
  const payload = parsePayload(row.payloadJson);
  return {
    resolution: typeof payload.resolution === "string" ? payload.resolution : null,
    resolved_at: row.createdAt ?? null,
    resolved_by: row.actorUserId ?? null,
    payload,
  };
}

export async function reviewPhotoProposal(
  env: AutoWriteEnv,
  db: Db,
  input: ReviewProposalInput
): Promise<ReviewProposalResult> {
  const [proposal] = await db
    .select({
      id: adminActions.id,
      action: adminActions.action,
      inboundEmailId: adminActions.targetId,
      payloadJson: adminActions.payloadJson,
    })
    .from(adminActions)
    .where(eq(adminActions.id, input.proposalId))
    .limit(1);
  if (
    !proposal ||
    (proposal.action !== BOOTH_PROPOSED_ACTION && proposal.action !== PERFORMER_PROPOSED_ACTION)
  ) {
    return {
      ok: false,
      code: "not_found",
      error: `No staged photo proposal with id ${input.proposalId}. Use the id list_photo_proposals returns.`,
    };
  }

  const prior = await findResolution(db, proposal.id);
  if (prior) {
    return {
      ok: true,
      proposal_id: proposal.id,
      already_resolved: true,
      resolution: prior.resolution,
      detail: {
        ...prior.payload,
        resolved_at: prior.resolved_at,
        resolved_by: prior.resolved_by,
      },
    };
  }

  const payload = parsePayload(proposal.payloadJson) as ProposalPayload;
  const note = input.note?.trim() || null;
  const base = {
    resolution: RESOLUTION_FOR[input.decision],
    email_id: proposal.inboundEmailId,
    event_id: payload.event_id ?? null,
    note,
    via: "mcp:review_photo_proposal",
  };

  let detail: Record<string, unknown> = base;

  if (input.decision === "approve") {
    if (proposal.action !== BOOTH_PROPOSED_ACTION) {
      return {
        ok: false,
        code: "not_booth",
        error:
          "approve applies to booth proposals. For a performer proposal, link the performer with link_performer_to_event, then close this one with decision='already_handled'.",
      };
    }
    if (!payload.event_id) {
      return { ok: false, code: "no_event", error: "Proposal has no resolved event." };
    }

    let vendorName: string | null = null;
    if (input.vendorId) {
      const [v] = await db
        .select({ businessName: vendors.businessName })
        .from(vendors)
        .where(eq(vendors.id, input.vendorId))
        .limit(1);
      vendorName = v?.businessName ?? null;
    }
    const businessName = (
      input.businessName?.trim() ||
      vendorName ||
      payload.business_name ||
      ""
    ).trim();
    if (!businessName) {
      return {
        ok: false,
        code: "no_name",
        error:
          "The photo's sign was not read. Pass business_name (or vendor_id for an existing vendor) to approve it.",
      };
    }

    const result = await createOrLinkVendor(
      db,
      {
        eventId: payload.event_id,
        businessName,
        // Kept with a typed-in name, as the UI route does: the website and
        // products are what the PHOTO shows, whoever read the lettering.
        website: payload.website ?? null,
        products: payload.products ?? null,
        status: "CONFIRMED",
        participationType: "EXHIBITOR",
        dedupStrategy: "strict",
        matchByDomain: true,
        vendorId: input.vendorId ?? null,
      },
      { actorUserId: input.actorUserId, recomputeVendorCompleteness, logEnrichment }
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        ...(result.code ? { code: result.code, candidates: result.domainCandidates } : {}),
      };
    }

    // Logo if blank, gallery otherwise. Never overwrite a logo.
    let photo: "logo" | "gallery" | "none" = "none";
    let photoError: string | null = null;
    if (payload.photo_key) {
      const [v] = await db
        .select({ logoUrl: vendors.logoUrl })
        .from(vendors)
        .where(eq(vendors.id, result.vendorId))
        .limit(1);
      const role = v?.logoUrl ? "gallery" : "logo";
      const ok = await postBoothPhoto(env, result.vendorId, payload.photo_key, role);
      if (ok) photo = role;
      else photoError = `photo upload as ${role} failed; the vendor link was still written`;
    } else {
      photoError = "proposal carries no photo_key";
    }

    detail = {
      ...base,
      vendor_id: result.vendorId,
      vendor_slug: result.vendorSlug,
      business_name: businessName,
      was_created: result.wasCreated,
      was_linked: result.wasLinked,
      was_already_linked: result.wasAlreadyLinked,
      match_basis: result.matchBasis,
      matched_domain: result.matchedDomain,
      // Same key the UI route writes, so either path reads the same.
      hero_set: photo === "logo",
      photo_written_as: photo,
      ...(photoError ? { photo_error: photoError } : {}),
    };
  }

  const now = new Date();
  await db.insert(adminActions).values({
    action: PHOTO_RESOLVED_ACTION,
    actorUserId: input.actorUserId,
    targetType: "admin_action",
    targetId: proposal.id,
    payloadJson: JSON.stringify(detail),
    createdAt: now,
  } as never);

  return {
    ok: true,
    proposal_id: proposal.id,
    already_resolved: false,
    resolution: RESOLUTION_FOR[input.decision],
    detail: { ...detail, resolved_at: now, resolved_by: input.actorUserId },
  };
}
