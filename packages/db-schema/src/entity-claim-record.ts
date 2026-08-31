/**
 * OPE-236 §4 (Option B) — the canonical claim row, built in one place.
 *
 * `entity_claims` is the source of truth every admin-facing claim surface reads
 * (`/admin/claims`, `list_claims`). Three live paths stamped `vendors.claimed=1`
 * on a PRE-EXISTING listing and never wrote it, so a real claim landed with no
 * review surface and no audit trail. Measured 2026-08-30:
 * `admin_approve_vendor_claim` claimed `21-street-beads` at 17:46:49 with no
 * `entity_claims` row, while `approve_claim` on `gooseberry-leather-company`
 * 34 minutes later wrote one.
 *
 * Pure by design, matching the other shared modules here: this decides WHAT to
 * write and WHETHER to write it; the caller does the insert with its own `db`.
 * That is what lets the Next.js app and the MCP Worker — two separate deploy
 * artifacts that cannot import each other's code — run the identical rule.
 * A helper duplicated in both trees is precisely how a fix ends up wired into
 * one of two parallel paths.
 *
 * ⚠️ AUTHORING IS NOT CLAIMING. The register-at-signup branch is deliberately
 * NOT a caller. Of the 73 rows carrying `vendors.claimed=1`, 70 are listings the
 * registrant created themselves inside the same second — nobody claimed those
 * from anybody, and minting review items for them was the reason OPE-236 §3
 * (the backfill) was withdrawn on 2026-08-31. Only a claim over a listing that
 * already existed belongs in this table.
 */

export type EntityClaimEntityType = "VENDOR" | "PROMOTER" | "VENUE" | "PERFORMER";

export type EntityClaimMethod =
  | "EMAIL_MATCH"
  | "DOMAIN_MATCH"
  | "INVITE_TOKEN"
  | "EVIDENCE"
  | "ADMIN";

export type EntityClaimStatus = "PENDING" | "APPROVED" | "REJECTED" | "DISPUTED";

/** The subset of an existing `entity_claims` row this decision needs. */
export interface ExistingEntityClaim {
  userId: string;
  status: string;
}

/**
 * The row values for a claim that is ALREADY settled at the moment it is
 * recorded.
 *
 * All three callers verify ownership before they stamp `claimed=1` — an admin
 * approving out-of-band, a verified account whose email equals the listing's
 * contact email, a click on a link delivered to that contact email. So the row
 * is born `APPROVED` with `decidedAt` set, not `PENDING`: a PENDING row would
 * put an already-granted claim into the review queue and invite an admin to
 * "approve" ownership the claimant is already exercising.
 */
export function buildSettledEntityClaim(input: {
  entityType: EntityClaimEntityType;
  entityId: string;
  /** The account that now owns the listing. */
  userId: string;
  method: EntityClaimMethod;
  /** Who settled it — the admin for ADMIN, the claimant for self-service. */
  decidedBy: string;
  at: Date;
  evidence?: string | null;
}): {
  entityType: EntityClaimEntityType;
  entityId: string;
  userId: string;
  method: EntityClaimMethod;
  status: EntityClaimStatus;
  evidence: string | null;
  createdAt: Date;
  decidedAt: Date;
  decidedBy: string;
} {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    userId: input.userId,
    method: input.method,
    status: "APPROVED",
    evidence: input.evidence ?? null,
    // createdAt === decidedAt is truthful here and not a shortcut: the claim was
    // filed and settled by the same act. A backdated createdAt would imply a
    // review latency that never happened, and the queue-age metrics read it.
    createdAt: input.at,
    decidedAt: input.at,
    decidedBy: input.decidedBy,
  };
}

/**
 * Whether this path should insert a claim row, given what the table already
 * holds for this (entityType, entityId).
 *
 * Idempotency matters because every caller is re-runnable:
 * `admin_approve_vendor_claim` documents itself as idempotent, and a claim
 * confirmation link can be clicked twice from a mail client. Without this,
 * a second click mints a duplicate APPROVED row and `/admin/claims` starts
 * double-counting a single claim.
 *
 * Keyed on the CLAIMANT, not merely on the entity: a listing whose earlier
 * claim was REJECTED, or which was transferred to a different account, must
 * still be recordable — refusing there would lose the row for the very
 * transfer an admin just performed.
 */
export function shouldRecordEntityClaim(
  existing: readonly ExistingEntityClaim[],
  userId: string
): boolean {
  return !existing.some((c) => c.userId === userId && c.status === "APPROVED");
}
