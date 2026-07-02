/**
 * Admin claim-review core — OPE-65.
 *
 * The `/admin/claims` queue lets an admin approve or reject the PENDING /
 * DISPUTED claim requests filed against vendor + promoter listings (the rows
 * `resolveClaimAtSignup` and the self-serve funnel write to `entity_claims`).
 *
 * This is the side-effecting core (it performs the DB writes + fires the
 * decision email) so it can be unit-tested directly against better-sqlite3,
 * exactly like `resolve-claim-at-signup.ts`. The API route stays thin: validate
 * the body, call `approveClaim` / `rejectClaim`, map the outcome to a status.
 *
 * SECURITY invariants (mirror the signup path — do NOT regress):
 *   - Approving transfers OWNERSHIP. NEVER silently take a listing away from a
 *     different owner: if the entity is already claimed by someone else, refuse
 *     with `already_claimed_by_other` and touch nothing. A genuine dispute is a
 *     separate manual resolution.
 *   - Ownership writes mirror `approvePendingEmailMatchClaims` field-for-field
 *     (userId + claimed + claimedAt + claimedBy) and are guarded/idempotent.
 *   - Every decision writes an `admin_actions` audit row.
 *   - The decision email is best-effort: an email failure must NEVER roll back
 *     or throw past the mutation (same posture as the register route's
 *     verification email).
 *
 * VENUE claims are intentionally out of scope (no claim funnel yet) and are
 * filtered out of every path here.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { vendors, promoters, users, userRoles, entityClaims, adminActions } from "@/lib/db/schema";
import { decodeHtmlEntities } from "@/lib/utils";
import { enqueueEmail } from "@/lib/queues/producers";
import { claimDecisionTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/email/send";

export type ReviewEntityType = "VENDOR" | "PROMOTER";

export interface ReviewableClaim {
  id: string;
  entityType: ReviewEntityType;
  entityId: string;
  /** Display name (businessName / companyName), HTML-entity decoded. `null` if the entity row is missing. */
  entityName: string | null;
  entitySlug: string | null;
  claimantUserId: string;
  claimantEmail: string | null;
  claimantName: string | null;
  method: string;
  status: "PENDING" | "DISPUTED";
  evidence: string | null;
  createdAt: Date | null;
  /** How many entity_claims rows exist for this (entityType, entityId). */
  attemptCount: number;
}

export interface ApproveResult {
  ok: boolean;
  reason?:
    | "not_found"
    | "not_reviewable"
    | "unsupported_entity"
    | "entity_missing"
    | "already_claimed_by_other";
  entityType?: ReviewEntityType;
  entitySlug?: string | null;
  entityName?: string | null;
  claimantUserId?: string;
  claimantEmail?: string | null;
}

export interface RejectResult {
  ok: boolean;
  reason?: "not_found" | "not_reviewable";
  entityType?: ReviewEntityType;
  entitySlug?: string | null;
  entityName?: string | null;
  claimantUserId?: string;
  claimantEmail?: string | null;
  rejectReason?: string;
}

// D1 caps a statement at 100 bound parameters; chunk any id IN(...) under it.
const CHUNK = 90;
function chunk<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

/**
 * All PENDING / DISPUTED vendor + promoter claims, newest first, decorated with
 * the entity's display name + slug, the claimant's email + name, and a per-entity
 * attempt count. Claims are low-volume; the extra lookups are chunked only as a
 * standing guard against D1's 100-param cap.
 */
export async function listReviewableClaims(db: Database): Promise<ReviewableClaim[]> {
  const claims = await db
    .select({
      id: entityClaims.id,
      entityType: entityClaims.entityType,
      entityId: entityClaims.entityId,
      claimantUserId: entityClaims.userId,
      method: entityClaims.method,
      status: entityClaims.status,
      evidence: entityClaims.evidence,
      createdAt: entityClaims.createdAt,
    })
    .from(entityClaims)
    .where(
      and(
        inArray(entityClaims.status, ["PENDING", "DISPUTED"]),
        inArray(entityClaims.entityType, ["VENDOR", "PROMOTER"])
      )
    )
    .orderBy(desc(entityClaims.createdAt));

  if (claims.length === 0) return [];

  const vendorIds = [
    ...new Set(claims.filter((c) => c.entityType === "VENDOR").map((c) => c.entityId)),
  ];
  const promoterIds = [
    ...new Set(claims.filter((c) => c.entityType === "PROMOTER").map((c) => c.entityId)),
  ];
  const userIds = [...new Set(claims.map((c) => c.claimantUserId))];

  const vendorById = new Map<string, { name: string; slug: string }>();
  for (const ids of chunk(vendorIds)) {
    if (ids.length === 0) continue;
    const rows = await db
      .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
      .from(vendors)
      .where(inArray(vendors.id, ids));
    for (const r of rows) vendorById.set(r.id, { name: r.name, slug: r.slug as unknown as string });
  }

  const promoterById = new Map<string, { name: string; slug: string }>();
  for (const ids of chunk(promoterIds)) {
    if (ids.length === 0) continue;
    const rows = await db
      .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
      .from(promoters)
      .where(inArray(promoters.id, ids));
    for (const r of rows)
      promoterById.set(r.id, { name: r.name, slug: r.slug as unknown as string });
  }

  const userById = new Map<string, { email: string; name: string | null }>();
  for (const ids of chunk(userIds)) {
    if (ids.length === 0) continue;
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
    for (const r of rows) userById.set(r.id, { email: r.email, name: r.name });
  }

  // Per-entity attempt counts: COUNT(*) grouped by (entity_type, entity_id).
  const attemptCounts = new Map<string, number>();
  const allIds = [...vendorIds, ...promoterIds];
  for (const ids of chunk(allIds)) {
    if (ids.length === 0) continue;
    const rows = await db
      .select({
        entityType: entityClaims.entityType,
        entityId: entityClaims.entityId,
        count: sql<number>`COUNT(*)`,
      })
      .from(entityClaims)
      .where(inArray(entityClaims.entityId, ids))
      .groupBy(entityClaims.entityType, entityClaims.entityId);
    for (const r of rows) attemptCounts.set(`${r.entityType}:${r.entityId}`, Number(r.count ?? 0));
  }

  return claims.map((c) => {
    const entityType = c.entityType as ReviewEntityType;
    const entity =
      entityType === "VENDOR" ? vendorById.get(c.entityId) : promoterById.get(c.entityId);
    const claimant = userById.get(c.claimantUserId);
    return {
      id: c.id,
      entityType,
      entityId: c.entityId,
      entityName: entity ? decodeHtmlEntities(entity.name) : null,
      entitySlug: entity?.slug ?? null,
      claimantUserId: c.claimantUserId,
      claimantEmail: claimant?.email ?? null,
      claimantName: claimant?.name ? decodeHtmlEntities(claimant.name) : null,
      method: c.method,
      status: c.status as "PENDING" | "DISPUTED",
      evidence: c.evidence,
      createdAt: c.createdAt,
      attemptCount: attemptCounts.get(`${entityType}:${c.entityId}`) ?? 1,
    };
  });
}

interface EntityLookup {
  userId: string | null;
  claimed: boolean;
  name: string;
  slug: string;
  contactEmail: string | null;
}

async function loadEntity(
  db: Database,
  entityType: ReviewEntityType,
  entityId: string
): Promise<EntityLookup | undefined> {
  if (entityType === "VENDOR") {
    const [row] = await db
      .select({
        userId: vendors.userId,
        claimed: vendors.claimed,
        name: vendors.businessName,
        slug: vendors.slug,
        contactEmail: vendors.contactEmail,
      })
      .from(vendors)
      .where(eq(vendors.id, entityId))
      .limit(1);
    if (!row) return undefined;
    return { ...row, slug: row.slug as unknown as string };
  }
  const [row] = await db
    .select({
      userId: promoters.userId,
      claimed: promoters.claimed,
      name: promoters.companyName,
      slug: promoters.slug,
      contactEmail: promoters.contactEmail,
    })
    .from(promoters)
    .where(eq(promoters.id, entityId))
    .limit(1);
  if (!row) return undefined;
  return { ...row, slug: row.slug as unknown as string };
}

async function lookupClaimantEmail(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Fire the factual decision email to the claimant. BEST-EFFORT: never throws —
 * a queue/env failure is swallowed (transactional, not marketing, so no
 * suppression check). Mirrors the register route's best-effort verification send.
 */
async function sendDecisionEmailBestEffort(args: {
  to: string | null;
  entityName: string | null;
  decision: "approved" | "rejected";
  reason?: string;
  entityType: ReviewEntityType;
  entitySlug?: string | null;
}): Promise<void> {
  if (!args.to) return;
  try {
    const manageUrl =
      args.decision === "approved"
        ? args.entityType === "VENDOR"
          ? `${getSiteUrl()}/vendor/profile`
          : `${getSiteUrl()}/promoter/events`
        : undefined;
    const tpl = claimDecisionTemplate({
      entityName: args.entityName ?? "your listing",
      decision: args.decision,
      reason: args.reason,
      manageUrl,
    });
    await enqueueEmail({
      to: args.to,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      source: "claims.decision",
    });
  } catch {
    // Best-effort — the decision is already committed; an email failure must
    // never roll back or throw past the mutation.
  }
}

/**
 * Approve a PENDING / DISPUTED vendor|promoter claim: transfer ownership, grant
 * the role, mark the claim APPROVED, and audit. Refuses (touching nothing) when
 * the entity is already claimed by a DIFFERENT user.
 */
export async function approveClaim(
  db: Database,
  { claimId, actorUserId }: { claimId: string; actorUserId: string }
): Promise<ApproveResult> {
  const now = new Date();

  const [claim] = await db
    .select({
      id: entityClaims.id,
      entityType: entityClaims.entityType,
      entityId: entityClaims.entityId,
      userId: entityClaims.userId,
      method: entityClaims.method,
      status: entityClaims.status,
    })
    .from(entityClaims)
    .where(eq(entityClaims.id, claimId))
    .limit(1);

  if (!claim) return { ok: false, reason: "not_found" };
  if (claim.status !== "PENDING" && claim.status !== "DISPUTED") {
    return { ok: false, reason: "not_reviewable" };
  }
  if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") {
    return { ok: false, reason: "unsupported_entity" };
  }
  const entityType = claim.entityType;

  const entity = await loadEntity(db, entityType, claim.entityId);
  if (!entity) return { ok: false, reason: "entity_missing" };

  // No silent takeover: an entity already claimed by a DIFFERENT user is a
  // genuine dispute requiring manual resolution. Refuse, touch nothing.
  if (entity.claimed && entity.userId !== claim.userId) {
    return {
      ok: false,
      reason: "already_claimed_by_other",
      entityType,
      entitySlug: entity.slug,
      entityName: decodeHtmlEntities(entity.name),
    };
  }

  // Transfer ownership. Guarded by claimed=false (idempotent); if it's already
  // owned by this same claimant the guard makes the write a no-op, which is fine.
  if (entityType === "VENDOR") {
    await db
      .update(vendors)
      .set({ userId: claim.userId, claimed: true, claimedAt: now, claimedBy: claim.userId })
      .where(and(eq(vendors.id, claim.entityId), eq(vendors.claimed, false)));
  } else {
    await db
      .update(promoters)
      .set({ userId: claim.userId, claimed: true, claimedAt: now, claimedBy: claim.userId })
      .where(and(eq(promoters.id, claim.entityId), eq(promoters.claimed, false)));
  }

  // Grant the entity role (idempotent).
  await db
    .insert(userRoles)
    .values({ userId: claim.userId, role: entityType, grantedAt: now, grantedBy: actorUserId })
    .onConflictDoNothing();

  // Mark the claim APPROVED.
  await db
    .update(entityClaims)
    .set({ status: "APPROVED", decidedAt: now, decidedBy: actorUserId })
    .where(eq(entityClaims.id, claim.id));

  // Audit.
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action:
      entityType === "VENDOR"
        ? "vendor.claim_admin_review_approve"
        : "promoter.claim_admin_review_approve",
    actorUserId,
    targetType: entityType.toLowerCase(),
    targetId: claim.entityId,
    payloadJson: JSON.stringify({ via: "admin/claims", claimId, method: claim.method }),
    createdAt: now,
  });

  const claimantEmail = await lookupClaimantEmail(db, claim.userId);
  const entityName = decodeHtmlEntities(entity.name);

  await sendDecisionEmailBestEffort({
    to: claimantEmail,
    entityName,
    decision: "approved",
    entityType,
    entitySlug: entity.slug,
  });

  return {
    ok: true,
    entityType,
    entitySlug: entity.slug,
    entityName,
    claimantUserId: claim.userId,
    claimantEmail,
  };
}

/**
 * Reject a PENDING / DISPUTED claim. Marks the claim REJECTED (with decidedBy),
 * NEVER touches entity ownership, and records the reason in the audit payload +
 * decision email (no DB column for the reason — spec: no migration).
 */
export async function rejectClaim(
  db: Database,
  { claimId, actorUserId, reason }: { claimId: string; actorUserId: string; reason: string }
): Promise<RejectResult> {
  const now = new Date();

  const [claim] = await db
    .select({
      id: entityClaims.id,
      entityType: entityClaims.entityType,
      entityId: entityClaims.entityId,
      userId: entityClaims.userId,
      status: entityClaims.status,
    })
    .from(entityClaims)
    .where(eq(entityClaims.id, claimId))
    .limit(1);

  if (!claim) return { ok: false, reason: "not_found" };
  if (claim.status !== "PENDING" && claim.status !== "DISPUTED") {
    return { ok: false, reason: "not_reviewable" };
  }
  if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") {
    // Same guard as approve — VENUE has no claim funnel, treat as not reviewable.
    return { ok: false, reason: "not_reviewable" };
  }
  const entityType = claim.entityType;

  // Mark REJECTED. Ownership untouched.
  await db
    .update(entityClaims)
    .set({ status: "REJECTED", decidedAt: now, decidedBy: actorUserId })
    .where(eq(entityClaims.id, claim.id));

  // Audit — reason lives here (no DB column added).
  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action:
      entityType === "VENDOR"
        ? "vendor.claim_admin_review_reject"
        : "promoter.claim_admin_review_reject",
    actorUserId,
    targetType: entityType.toLowerCase(),
    targetId: claim.entityId,
    payloadJson: JSON.stringify({ via: "admin/claims", claimId, reason }),
    createdAt: now,
  });

  const entity = await loadEntity(db, entityType, claim.entityId);
  const entityName = entity ? decodeHtmlEntities(entity.name) : null;
  const claimantEmail = await lookupClaimantEmail(db, claim.userId);

  await sendDecisionEmailBestEffort({
    to: claimantEmail,
    entityName,
    decision: "rejected",
    reason,
    entityType,
    entitySlug: entity?.slug ?? null,
  });

  return {
    ok: true,
    entityType,
    entitySlug: entity?.slug ?? null,
    entityName,
    claimantUserId: claim.userId,
    claimantEmail,
    rejectReason: reason,
  };
}
