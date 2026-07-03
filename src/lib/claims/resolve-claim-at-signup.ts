/**
 * Claim-decision core for the signup funnel — OPE-59 / OPE-61.
 *
 * When a logged-out visitor lands on an unclaimed vendor/promoter page and
 * clicks "Claim this listing", they are funnelled to /register?claim=<slug>.
 * After the account is created, the register route calls this helper to decide
 * — SAFELY — what happens to that claim. It replaces the old
 * "placeholder owner → auto-transfer at signup" behavior, which claimed a
 * listing with NO verification.
 *
 * Three hard invariants (do NOT regress — this is the auth-adjacent claim path):
 *   1. NEVER claim a listing without verification. Only a contact-email match
 *      (rung 1) auto-approves; everything else is logged PENDING for review.
 *   2. NEVER overwrite a claim held by a DIFFERENT user. An already-claimed
 *      entity is left untouched and the attempt is logged DISPUTED.
 *   3. LOG EVERY attempt to `entity_claims` (except when the slug matches no
 *      entity at all — there is no entity_id to reference, and entity_id is
 *      NOT NULL).
 *
 * Domain-match (rung 2) is OPE-64 and intentionally out of scope here.
 *
 * This is the side-effecting core (it performs the DB writes) so it can be
 * unit-tested directly against better-sqlite3 without standing up the full
 * register route. The route stays thin: build the args, call this, map the
 * outcome to a client redirect.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { vendors, promoters, userRoles, entityClaims } from "@/lib/db/schema";
import { unsafeSlug } from "@/lib/utils";
import { insertClaimApprovedNotification } from "@/lib/claims/notify-approved";

export type ClaimEntityType = "VENDOR" | "PROMOTER";

export type ClaimOutcome =
  | "approved" // email match, approved ONLY after email verification (verify-token)
  | "pending_verification" // rung-1 email match at signup → PENDING until the user verifies their email (proves inbox control), then auto-approved
  | "needs_evidence" // no match / no contact email → PENDING, user must prove
  | "already_claimed" // held by a different user → DISPUTED, untouched
  | "entity_not_found"; // slug matched nothing (tampered / stale link)

export interface ResolveClaimAtSignupArgs {
  entityType: ClaimEntityType;
  /** Raw slug from the claim= URL param (boundary-cast internally). */
  slug: string;
  /** The freshly created account's id. */
  userId: string;
  /** The freshly created account's email (compared to the entity contact email). */
  userEmail: string;
}

export interface ResolveClaimAtSignupResult {
  outcome: ClaimOutcome;
  entityType: ClaimEntityType;
  /** Present whenever the entity was found (i.e. every outcome but entity_not_found). */
  entityId?: string;
  /** The entity_claims row id written for this attempt (absent for entity_not_found). */
  claimId?: string;
  /** The method recorded on the entity_claims row (absent for entity_not_found). */
  method?: "EMAIL_MATCH" | "EVIDENCE";
}

function normEmail(e: string | null | undefined): string {
  return (e ?? "").trim().toLowerCase();
}

export async function resolveClaimAtSignup(
  db: Database,
  { entityType, slug, userId, userEmail }: ResolveClaimAtSignupArgs
): Promise<ResolveClaimAtSignupResult> {
  const now = new Date();

  // 1. Look up the entity by slug. Vendors exclude soft-deleted rows.
  let entity:
    | { id: string; ownerUserId: string | null; claimed: boolean; contactEmail: string | null }
    | undefined;

  if (entityType === "VENDOR") {
    const [row] = await db
      .select({
        id: vendors.id,
        ownerUserId: vendors.userId,
        claimed: vendors.claimed,
        contactEmail: vendors.contactEmail,
      })
      .from(vendors)
      .where(and(eq(vendors.slug, unsafeSlug(slug)), isNull(vendors.deletedAt)))
      .limit(1);
    entity = row;
  } else {
    const [row] = await db
      .select({
        id: promoters.id,
        ownerUserId: promoters.userId,
        claimed: promoters.claimed,
        contactEmail: promoters.contactEmail,
      })
      .from(promoters)
      .where(eq(promoters.slug, unsafeSlug(slug)))
      .limit(1);
    entity = row;
  }

  // No entity → nothing to claim and nothing to log against (entity_id NOT NULL).
  if (!entity) {
    return { outcome: "entity_not_found", entityType };
  }

  const emailMatch =
    normEmail(entity.contactEmail).length > 0 &&
    normEmail(entity.contactEmail) === normEmail(userEmail);

  // 2. Invariant #2 — already claimed → NEVER overwrite. The freshly created
  //    account is by definition a different user than any existing owner, so a
  //    claimed entity is always a genuine dispute here. Log DISPUTED, touch
  //    nothing. Method reflects the rung the claimant would have qualified for.
  if (entity.claimed) {
    const method = emailMatch ? "EMAIL_MATCH" : "EVIDENCE";
    const claimId = crypto.randomUUID();
    await db.insert(entityClaims).values({
      id: claimId,
      entityType,
      entityId: entity.id,
      userId,
      method,
      status: "DISPUTED",
      createdAt: now,
    });
    return { outcome: "already_claimed", entityType, entityId: entity.id, claimId, method };
  }

  // 3. Rung 1 — email match. SECURITY: the account email MATCHES the entity's
  //    contact email, but at signup that email is NOT yet verified. Approving
  //    here would let anyone claim a listing by merely TYPING its contact email
  //    without proving they control that inbox (account-takeover). So record
  //    PENDING (EMAIL_MATCH) and DEFER the ownership flip to
  //    approvePendingEmailMatchClaims(), which runs from the email-verification
  //    callback (verify-token.ts) once the user clicks the link and PROVES inbox
  //    control. (Spec §4.2: "email verification required before approval.")
  if (emailMatch) {
    const claimId = crypto.randomUUID();
    await db.insert(entityClaims).values({
      id: claimId,
      entityType,
      entityId: entity.id,
      userId,
      method: "EMAIL_MATCH",
      status: "PENDING",
      createdAt: now,
    });
    return {
      outcome: "pending_verification",
      entityType,
      entityId: entity.id,
      claimId,
      method: "EMAIL_MATCH",
    };
  }

  // 4. No contact email, or it didn't match → do NOT claim. Log PENDING so the
  //    "verify another way" evidence flow (and the admin queue) can pick it up.
  const claimId = crypto.randomUUID();
  await db.insert(entityClaims).values({
    id: claimId,
    entityType,
    entityId: entity.id,
    userId,
    method: "EVIDENCE",
    status: "PENDING",
    createdAt: now,
  });
  return {
    outcome: "needs_evidence",
    entityType,
    entityId: entity.id,
    claimId,
    method: "EVIDENCE",
  };
}

/**
 * OPE-59 SECURITY — approve the caller's PENDING email-match claims once their
 * email is verified. Called from the email-verification consume path
 * (src/lib/email/verify-token.ts) right after `users.emailVerified` is set:
 * clicking the verification link PROVES control of the inbox whose address
 * matched the entity's contact email — the ownership proof rung 1 requires and
 * that resolveClaimAtSignup deliberately does NOT assert at signup.
 *
 * For each of the user's PENDING EMAIL_MATCH claims it re-checks, against the
 * entity's CURRENT state: (a) still unclaimed — else DISPUTED, never overwrite;
 * (b) the contact email still equals the now-verified account email — else
 * leave PENDING (contact email changed/cleared). Only then does it flip
 * ownership + grant the role + mark the claim APPROVED. Idempotent and
 * best-effort (the caller must not let a failure here block verification).
 */
export async function approvePendingEmailMatchClaims(
  db: Database,
  userId: string,
  verifiedEmail: string
): Promise<{
  approved: number;
  /** Slugs of the entities whose claims were approved on this call — for OPE-66
   *  claim_completed_server GA4 events fired by the verify-email surface. */
  approvedClaims: Array<{ entityType: ClaimEntityType; entitySlug: string }>;
}> {
  const now = new Date();
  const approvedClaims: Array<{ entityType: ClaimEntityType; entitySlug: string }> = [];
  const pending = await db
    .select({
      id: entityClaims.id,
      entityType: entityClaims.entityType,
      entityId: entityClaims.entityId,
    })
    .from(entityClaims)
    .where(
      and(
        eq(entityClaims.userId, userId),
        eq(entityClaims.method, "EMAIL_MATCH"),
        eq(entityClaims.status, "PENDING")
      )
    );

  let approved = 0;
  for (const claim of pending) {
    if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") continue;
    const entityType = claim.entityType;
    const role = entityType === "VENDOR" ? "VENDOR" : "PROMOTER";

    let entity: { claimed: boolean; contactEmail: string | null; slug: string } | undefined;
    if (entityType === "VENDOR") {
      const [row] = await db
        .select({
          claimed: vendors.claimed,
          contactEmail: vendors.contactEmail,
          slug: vendors.slug,
        })
        .from(vendors)
        .where(eq(vendors.id, claim.entityId))
        .limit(1);
      entity = row;
    } else {
      const [row] = await db
        .select({
          claimed: promoters.claimed,
          contactEmail: promoters.contactEmail,
          slug: promoters.slug,
        })
        .from(promoters)
        .where(eq(promoters.id, claim.entityId))
        .limit(1);
      entity = row;
    }
    if (!entity) continue;

    // Claimed by someone else in the interim → dispute, never overwrite.
    if (entity.claimed) {
      await db
        .update(entityClaims)
        .set({ status: "DISPUTED", decidedAt: now })
        .where(eq(entityClaims.id, claim.id));
      continue;
    }
    // The match must still hold against the entity's CURRENT contact email.
    if (
      normEmail(entity.contactEmail).length === 0 ||
      normEmail(entity.contactEmail) !== normEmail(verifiedEmail)
    ) {
      continue; // leave PENDING — contact email changed or was cleared
    }

    // Verified inbox control proven → transfer ownership + grant role + APPROVE.
    if (entityType === "VENDOR") {
      await db
        .update(vendors)
        .set({ userId, claimed: true, claimedAt: now, claimedBy: userId })
        .where(and(eq(vendors.id, claim.entityId), eq(vendors.claimed, false)));
    } else {
      await db
        .update(promoters)
        .set({ userId, claimed: true, claimedAt: now, claimedBy: userId })
        .where(and(eq(promoters.id, claim.entityId), eq(promoters.claimed, false)));
    }
    await db
      .insert(userRoles)
      .values({ userId, role, grantedAt: now, grantedBy: userId })
      .onConflictDoNothing();
    await db
      .update(entityClaims)
      .set({ status: "APPROVED", decidedAt: now, decidedBy: userId })
      .where(eq(entityClaims.id, claim.id));
    await insertClaimApprovedNotification(db, {
      userId,
      entityType,
      entitySlug: entity.slug,
    });
    approved++;
    approvedClaims.push({ entityType, entitySlug: entity.slug });
  }

  return { approved, approvedClaims };
}
