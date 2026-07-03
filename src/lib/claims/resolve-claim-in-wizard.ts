/**
 * Claim-decision core for the self-serve claim WIZARD — OPE-64.
 *
 * The wizard (`/claim/vendor/[slug]`, `/claim/promoter/[slug]`) walks a signed-in
 * user through the verification ladder. This is the side-effecting core it POSTs
 * to (via /api/claim/wizard): it evaluates the ladder IN ORDER and — for every
 * found entity — writes an `entity_claims` row describing the attempt.
 *
 * It reuses the OPE-59 ownership-transfer discipline field-for-field (see
 * resolve-claim-at-signup.ts + admin-review.ts):
 *   - Ownership writes are guarded by `claimed = false` (idempotent, no takeover).
 *   - Role grant is `onConflictDoNothing`.
 *   - Every APPROVED write records decidedAt/decidedBy and an adminActions audit.
 *   - An entity already claimed by a DIFFERENT user is a DISPUTE — never overwrite.
 *
 * THE #1 SECURITY INVARIANT (OPE-59): NEVER auto-approve a claim on an UNVERIFIED
 * account email. Instant approval (email-match OR domain-match) requires
 * `emailVerified`. If the account email is not yet verified, the claim is recorded
 * PENDING and approval is DEFERRED to the email-verification callback — the proven
 * `approvePendingEmailMatchClaims` pattern, mirrored here as
 * `approvePendingDomainMatchClaims`.
 *
 * SSRF (K30): domain match is a PURE STRING comparison of the STORED website vs
 * the account email. The website URL is NEVER fetched.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { vendors, promoters, userRoles, entityClaims, adminActions } from "@/lib/db/schema";
import { unsafeSlug } from "@/lib/utils";
import { decideDomainMatch } from "@/lib/claims/domain-match";
import { insertClaimApprovedNotification } from "@/lib/claims/notify-approved";

export type ClaimEntityType = "VENDOR" | "PROMOTER";

export type WizardClaimMethod = "EMAIL_MATCH" | "DOMAIN_MATCH" | "EVIDENCE";

export type WizardOutcome =
  | "approved" // instant approve (verified email + email/domain match)
  | "pending_verification" // email/domain match but email UNVERIFIED → PENDING, deferred
  | "needs_evidence" // no automatic proof → PENDING EVIDENCE, operator review
  | "already_yours" // already owned by this same user
  | "already_claimed" // held by a DIFFERENT user → DISPUTED, untouched
  | "entity_not_found";

export interface ResolveClaimInWizardArgs {
  entityType: ClaimEntityType;
  /** Raw slug from the URL param (boundary-cast internally). */
  slug: string;
  userId: string;
  userEmail: string;
  /** Whether the account's email is verified (loaded from users.emailVerified — NEVER client-supplied). */
  emailVerified: boolean;
}

export interface ResolveClaimInWizardResult {
  outcome: WizardOutcome;
  entityType: ClaimEntityType;
  entityId?: string;
  entitySlug?: string;
  entityName?: string;
  claimId?: string;
  method?: WizardClaimMethod;
}

interface WizardEntity {
  id: string;
  ownerUserId: string | null;
  claimed: boolean;
  contactEmail: string | null;
  website: string | null;
  name: string;
  slug: string;
}

function normEmail(e: string | null | undefined): string {
  return (e ?? "").trim().toLowerCase();
}

async function loadEntity(
  db: Database,
  entityType: ClaimEntityType,
  slug: string
): Promise<WizardEntity | undefined> {
  if (entityType === "VENDOR") {
    const [row] = await db
      .select({
        id: vendors.id,
        ownerUserId: vendors.userId,
        claimed: vendors.claimed,
        contactEmail: vendors.contactEmail,
        website: vendors.website,
        name: vendors.businessName,
        slug: vendors.slug,
      })
      .from(vendors)
      .where(and(eq(vendors.slug, unsafeSlug(slug)), isNull(vendors.deletedAt)))
      .limit(1);
    return row ? { ...row, slug: row.slug as unknown as string } : undefined;
  }
  const [row] = await db
    .select({
      id: promoters.id,
      ownerUserId: promoters.userId,
      claimed: promoters.claimed,
      contactEmail: promoters.contactEmail,
      website: promoters.website,
      name: promoters.companyName,
      slug: promoters.slug,
    })
    .from(promoters)
    .where(eq(promoters.slug, unsafeSlug(slug)))
    .limit(1);
  return row ? { ...row, slug: row.slug as unknown as string } : undefined;
}

/**
 * Instant-approve core: transfer ownership (guarded by claimed=false), grant the
 * role (idempotent), write the APPROVED entity_claims row + adminActions audit,
 * and fire the best-effort notification. Mirrors approvePendingEmailMatchClaims /
 * approveClaim. Only ever called on the verified-email path.
 */
async function approveNow(
  db: Database,
  entityType: ClaimEntityType,
  entity: WizardEntity,
  userId: string,
  method: "EMAIL_MATCH" | "DOMAIN_MATCH",
  now: Date
): Promise<string> {
  const role = entityType === "VENDOR" ? "VENDOR" : "PROMOTER";

  if (entityType === "VENDOR") {
    await db
      .update(vendors)
      .set({ userId, claimed: true, claimedAt: now, claimedBy: userId })
      .where(and(eq(vendors.id, entity.id), eq(vendors.claimed, false)));
  } else {
    await db
      .update(promoters)
      .set({ userId, claimed: true, claimedAt: now, claimedBy: userId })
      .where(and(eq(promoters.id, entity.id), eq(promoters.claimed, false)));
  }

  await db
    .insert(userRoles)
    .values({ userId, role, grantedAt: now, grantedBy: userId })
    .onConflictDoNothing();

  const claimId = crypto.randomUUID();
  await db.insert(entityClaims).values({
    id: claimId,
    entityType,
    entityId: entity.id,
    userId,
    method,
    status: "APPROVED",
    createdAt: now,
    decidedAt: now,
    decidedBy: userId,
  });

  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action:
      entityType === "VENDOR" ? "vendor.claim_wizard_approve" : "promoter.claim_wizard_approve",
    actorUserId: userId,
    targetType: entityType.toLowerCase(),
    targetId: entity.id,
    payloadJson: JSON.stringify({ via: "claim/wizard", claimId, method }),
    createdAt: now,
  });

  await insertClaimApprovedNotification(db, {
    userId,
    entityType,
    entitySlug: entity.slug,
    entityName: entity.name,
  });

  return claimId;
}

async function recordPending(
  db: Database,
  entityType: ClaimEntityType,
  entityId: string,
  userId: string,
  method: WizardClaimMethod,
  now: Date
): Promise<string> {
  const claimId = crypto.randomUUID();
  await db.insert(entityClaims).values({
    id: claimId,
    entityType,
    entityId,
    userId,
    method,
    status: "PENDING",
    createdAt: now,
  });
  return claimId;
}

export async function resolveClaimInWizard(
  db: Database,
  { entityType, slug, userId, userEmail, emailVerified }: ResolveClaimInWizardArgs
): Promise<ResolveClaimInWizardResult> {
  const now = new Date();

  const entity = await loadEntity(db, entityType, slug);

  // 1. No entity → nothing to claim, nothing to log (entity_id is NOT NULL).
  if (!entity) {
    return { outcome: "entity_not_found", entityType };
  }

  const base = {
    entityType,
    entityId: entity.id,
    entitySlug: entity.slug,
    entityName: entity.name,
  } as const;

  // 2. Already claimed.
  if (entity.claimed) {
    // Already this user's — nothing to do, no new row.
    if (entity.ownerUserId === userId) {
      return { outcome: "already_yours", ...base };
    }
    // Held by a DIFFERENT user → DISPUTE. Log DISPUTED, overwrite NOTHING. Method
    // reflects the rung the claimant would otherwise have qualified for.
    const emailMatch =
      normEmail(entity.contactEmail).length > 0 &&
      normEmail(entity.contactEmail) === normEmail(userEmail);
    const method: WizardClaimMethod = emailMatch
      ? "EMAIL_MATCH"
      : decideDomainMatch(userEmail, entity.website).match
        ? "DOMAIN_MATCH"
        : "EVIDENCE";
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
    return { outcome: "already_claimed", ...base, claimId, method };
  }

  // 3. Rung 1 — email match (contact email == account email, case-insensitive).
  const emailMatch =
    normEmail(entity.contactEmail).length > 0 &&
    normEmail(entity.contactEmail) === normEmail(userEmail);
  if (emailMatch) {
    if (emailVerified) {
      const claimId = await approveNow(db, entityType, entity, userId, "EMAIL_MATCH", now);
      return { outcome: "approved", ...base, claimId, method: "EMAIL_MATCH" };
    }
    // SECURITY: unverified email — DEFER to the verification callback.
    const claimId = await recordPending(db, entityType, entity.id, userId, "EMAIL_MATCH", now);
    return { outcome: "pending_verification", ...base, claimId, method: "EMAIL_MATCH" };
  }

  // 4. Rung 2 — domain match (STORED website's registrable domain == the email's).
  //    PURE string comparison; the website is NEVER fetched (SSRF K30).
  if (decideDomainMatch(userEmail, entity.website).match) {
    if (emailVerified) {
      const claimId = await approveNow(db, entityType, entity, userId, "DOMAIN_MATCH", now);
      return { outcome: "approved", ...base, claimId, method: "DOMAIN_MATCH" };
    }
    // SECURITY: unverified email — DEFER to approvePendingDomainMatchClaims, which
    // RE-VALIDATES the match against the entity's CURRENT website at approval time.
    const claimId = await recordPending(db, entityType, entity.id, userId, "DOMAIN_MATCH", now);
    return { outcome: "pending_verification", ...base, claimId, method: "DOMAIN_MATCH" };
  }

  // 5. No automatic proof → PENDING EVIDENCE (rung 4, operator review).
  const claimId = await recordPending(db, entityType, entity.id, userId, "EVIDENCE", now);
  return { outcome: "needs_evidence", ...base, claimId, method: "EVIDENCE" };
}

/**
 * OPE-64 SECURITY — approve the caller's PENDING DOMAIN_MATCH claims once their
 * email is verified. The domain analog of approvePendingEmailMatchClaims: called
 * from the email-verification consume path (verify-token.ts) right after the
 * email-match approval, because verifying the email PROVES the user controls an
 * inbox at the matched registrable domain — the ownership proof rung 2 requires
 * and that resolveClaimInWizard deliberately does NOT assert while unverified.
 *
 * For each PENDING DOMAIN_MATCH claim it RE-VALIDATES, against the entity's
 * CURRENT state, BOTH:
 *   (a) the entity is still unclaimed — else DISPUTED, never overwrite; and
 *   (b) `decideDomainMatch(verifiedEmail, entity.website).match` STILL holds —
 *       else leave PENDING (the website could have changed between wizard and
 *       verification; re-checking here is the security gate).
 * Only then does it transfer ownership + grant the role + mark APPROVED.
 * Idempotent and best-effort (the caller must not let a failure block verify).
 */
export async function approvePendingDomainMatchClaims(
  db: Database,
  userId: string,
  verifiedEmail: string
): Promise<{
  approved: number;
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
        eq(entityClaims.method, "DOMAIN_MATCH"),
        eq(entityClaims.status, "PENDING")
      )
    );

  let approved = 0;
  for (const claim of pending) {
    if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") continue;
    const entityType = claim.entityType;
    const role = entityType === "VENDOR" ? "VENDOR" : "PROMOTER";

    let entity:
      | { claimed: boolean; website: string | null; slug: string; name: string }
      | undefined;
    if (entityType === "VENDOR") {
      const [row] = await db
        .select({
          claimed: vendors.claimed,
          website: vendors.website,
          slug: vendors.slug,
          name: vendors.businessName,
        })
        .from(vendors)
        .where(eq(vendors.id, claim.entityId))
        .limit(1);
      entity = row ? { ...row, slug: row.slug as unknown as string } : undefined;
    } else {
      const [row] = await db
        .select({
          claimed: promoters.claimed,
          website: promoters.website,
          slug: promoters.slug,
          name: promoters.companyName,
        })
        .from(promoters)
        .where(eq(promoters.id, claim.entityId))
        .limit(1);
      entity = row ? { ...row, slug: row.slug as unknown as string } : undefined;
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

    // SECURITY re-check: the domain match must STILL hold against the entity's
    // CURRENT website (it may have changed since the wizard recorded PENDING).
    if (!decideDomainMatch(verifiedEmail, entity.website).match) {
      continue; // leave PENDING — website changed / no longer matches
    }

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

    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action:
        entityType === "VENDOR"
          ? "vendor.claim_domain_match_approve"
          : "promoter.claim_domain_match_approve",
      actorUserId: userId,
      targetType: entityType.toLowerCase(),
      targetId: claim.entityId,
      payloadJson: JSON.stringify({
        via: "verify-email",
        claimId: claim.id,
        method: "DOMAIN_MATCH",
      }),
      createdAt: now,
    });

    await insertClaimApprovedNotification(db, {
      userId,
      entityType,
      entitySlug: entity.slug,
      entityName: entity.name,
    });

    approved++;
    approvedClaims.push({ entityType, entitySlug: entity.slug });
  }

  return { approved, approvedClaims };
}
