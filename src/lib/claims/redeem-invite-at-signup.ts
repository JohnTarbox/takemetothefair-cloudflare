/**
 * OPE-1692 — redeem a cold claim invite inside the register funnel.
 *
 * `create_claim_invite` emails a link of the form
 *   /register?role=PROMOTER&claim=<slug>&invite=<raw token>
 * and `redeemClaimToken` (OPE-67) was written to consume it. Until this file,
 * NOTHING called it: the register page never read `invite`, the register API
 * never received it, and the claim fell through to `resolveClaimAtSignup`,
 * which only knows the listing's contact email. Specimen: claim 317c3099 (Owls
 * Head Transportation Museum, 2026-11-17) — the invite went to one staff
 * mailbox, a colleague signed up with another on the same domain, the
 * contact-email rung did not match, and the claim landed PENDING / EVIDENCE.
 *
 * Two rungs, both requiring a valid, unexpired invite token for the entity:
 *
 *   1. EXACT — the account email equals the invited email. Delegates to
 *      `redeemClaimToken` unchanged: the link reached that inbox AND the account
 *      owns that address, so ownership transfers now (OPE-67 trust model).
 *
 *   2. SAME ORGANIZATION — the account email is a DIFFERENT mailbox on the same
 *      ownable registrable domain as the invited email (a forwarded invite
 *      inside one organization, which is what happened here). A click alone is
 *      not proof — a link can be forwarded anywhere — so this records the claim
 *      PENDING (method INVITE_TOKEN) and defers the ownership flip to
 *      `approvePendingInviteDomainClaims`, which runs from the email-verification
 *      callback once the user proves control of an inbox on that domain. This is
 *      the same shape as rung 2 of the wizard ladder (DOMAIN_MATCH, OPE-64):
 *      verified inbox on the organization's domain, never an unverified flip.
 *      Freemail and other non-ownable domains never match (`isNonOwnableDomain`).
 *
 * Anything else (no token, unknown/expired token, other domain, entity already
 * claimed by someone else) returns `not_applicable` and the caller falls back
 * to `resolveClaimAtSignup` exactly as before.
 */
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  vendors,
  promoters,
  userRoles,
  entityClaims,
  claimTokens,
  adminActions,
} from "@/lib/db/schema";
import { isNonOwnableDomain } from "@takemetothefair/utils";
import { decodeHtmlEntities } from "@/lib/utils";
import { redeemClaimToken, type RedeemEntityType } from "@/lib/claims/redeem-claim-token";
import { registrableDomainFromEmail } from "@/lib/claims/domain-match";
import { recordClaimantAsPromoterContact } from "@/lib/claims/promoter-contact";
import { insertClaimApprovedNotification } from "@/lib/claims/notify-approved";

export type InviteAtSignupResult =
  | {
      kind: "redeemed";
      entityType: RedeemEntityType;
      entitySlug: string;
      entityName: string;
    }
  | {
      kind: "pending_verification";
      entityType: RedeemEntityType;
      entityId: string;
      entitySlug: string;
      entityName: string;
      claimId: string;
    }
  | {
      kind: "not_applicable";
      reason:
        | "invalid"
        | "expired"
        | "role_mismatch"
        | "entity_missing"
        | "already_claimed_by_other"
        | "email_mismatch";
    };

export interface InviteSummary {
  tokenId: string;
  entityType: RedeemEntityType;
  entityId: string;
  entitySlug: string;
  entityName: string;
  claimed: boolean;
  ownerUserId: string | null;
  invitedEmail: string;
  expired: boolean;
}

function normEmail(e: string | null | undefined): string {
  return (e ?? "").trim().toLowerCase();
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Same organization = same registrable domain, and that domain is ownable. */
export function sameOwnableDomain(a: string, b: string): boolean {
  const da = registrableDomainFromEmail(a);
  const dbm = registrableDomainFromEmail(b);
  if (!da || !dbm || da !== dbm) return false;
  return !isNonOwnableDomain(da);
}

async function loadEntity(
  db: Database,
  entityType: RedeemEntityType,
  entityId: string
): Promise<
  { slug: string; name: string; claimed: boolean; ownerUserId: string | null } | undefined
> {
  if (entityType === "VENDOR") {
    const [row] = await db
      .select({
        slug: vendors.slug,
        name: vendors.businessName,
        claimed: vendors.claimed,
        ownerUserId: vendors.userId,
      })
      .from(vendors)
      .where(eq(vendors.id, entityId))
      .limit(1);
    return row ? { ...row, slug: row.slug as unknown as string } : undefined;
  }
  const [row] = await db
    .select({
      slug: promoters.slug,
      name: promoters.companyName,
      claimed: promoters.claimed,
      ownerUserId: promoters.userId,
    })
    .from(promoters)
    .where(eq(promoters.id, entityId))
    .limit(1);
  return row ? { ...row, slug: row.slug as unknown as string } : undefined;
}

/**
 * Read-only lookup of an invite token, for the register page banner and for
 * the signup decision. NEVER returns the invited email to a public caller —
 * `/api/claim/invite` strips it.
 */
export async function lookupInvite(db: Database, rawToken: string): Promise<InviteSummary | null> {
  if (!rawToken || rawToken.length > 200) return null;
  const tokenHash = await sha256Hex(rawToken);
  const [token] = await db
    .select({
      id: claimTokens.id,
      entityType: claimTokens.entityType,
      entityId: claimTokens.entityId,
      email: claimTokens.email,
      expiresAt: claimTokens.expiresAt,
    })
    .from(claimTokens)
    .where(eq(claimTokens.tokenHash, tokenHash))
    .limit(1);
  if (!token) return null;
  if (token.entityType !== "VENDOR" && token.entityType !== "PROMOTER") return null;
  const entity = await loadEntity(db, token.entityType, token.entityId);
  if (!entity) return null;
  return {
    tokenId: token.id,
    entityType: token.entityType,
    entityId: token.entityId,
    entitySlug: entity.slug,
    entityName: decodeHtmlEntities(entity.name),
    claimed: entity.claimed,
    ownerUserId: entity.ownerUserId,
    invitedEmail: normEmail(token.email),
    expired: token.expiresAt.getTime() <= Date.now(),
  };
}

export async function redeemInviteAtSignup(
  db: Database,
  {
    rawToken,
    userId,
    userEmail,
    role,
  }: { rawToken: string; userId: string; userEmail: string; role: RedeemEntityType }
): Promise<InviteAtSignupResult> {
  const invite = await lookupInvite(db, rawToken);
  if (!invite) return { kind: "not_applicable", reason: "invalid" };
  if (invite.expired) return { kind: "not_applicable", reason: "expired" };
  if (invite.entityType !== role) return { kind: "not_applicable", reason: "role_mismatch" };
  if (invite.claimed && invite.ownerUserId !== userId) {
    return { kind: "not_applicable", reason: "already_claimed_by_other" };
  }

  const account = normEmail(userEmail);

  // Rung 1 — exact address. redeemClaimToken re-checks everything itself.
  if (invite.invitedEmail.length > 0 && invite.invitedEmail === account) {
    const res = await redeemClaimToken(db, { rawToken, userId });
    if (res.ok) {
      return {
        kind: "redeemed",
        entityType: invite.entityType,
        entitySlug: res.entitySlug ?? invite.entitySlug,
        entityName: res.entityName ?? invite.entityName,
      };
    }
    return {
      kind: "not_applicable",
      reason: res.reason === "email_mismatch" ? "email_mismatch" : (res.reason ?? "invalid"),
    };
  }

  // Rung 2 — same organization, approval deferred to email verification.
  if (invite.invitedEmail.length > 0 && sameOwnableDomain(invite.invitedEmail, account)) {
    const claimId = crypto.randomUUID();
    await db.insert(entityClaims).values({
      id: claimId,
      entityType: invite.entityType,
      entityId: invite.entityId,
      userId,
      method: "INVITE_TOKEN",
      status: "PENDING",
      evidence: JSON.stringify({
        via: "invite-same-domain",
        tokenId: invite.tokenId,
        invitedDomain: registrableDomainFromEmail(invite.invitedEmail),
      }),
      createdAt: new Date(),
    });
    return {
      kind: "pending_verification",
      entityType: invite.entityType,
      entityId: invite.entityId,
      entitySlug: invite.entitySlug,
      entityName: invite.entityName,
      claimId,
    };
  }

  return { kind: "not_applicable", reason: "email_mismatch" };
}

/**
 * OPE-1692 — the email-verification half of rung 2. Called from
 * verify-token.ts after the user proves control of `verifiedEmail`.
 *
 * For each of the user's PENDING INVITE_TOKEN claims it RE-VALIDATES against
 * current state: an unexpired invite token still exists for that entity whose
 * invited address is on the same ownable domain as the verified email, and the
 * entity is still unclaimed (else DISPUTED, never overwrite). Only then does it
 * transfer ownership, grant the role, approve the claim and consume the token.
 * Idempotent; the caller treats a throw as best-effort.
 */
export async function approvePendingInviteDomainClaims(
  db: Database,
  userId: string,
  verifiedEmail: string
): Promise<{
  approved: number;
  approvedClaims: Array<{ entityType: RedeemEntityType; entitySlug: string }>;
}> {
  const now = new Date();
  const approvedClaims: Array<{ entityType: RedeemEntityType; entitySlug: string }> = [];
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
        eq(entityClaims.method, "INVITE_TOKEN"),
        eq(entityClaims.status, "PENDING")
      )
    );

  for (const claim of pending) {
    if (claim.entityType !== "VENDOR" && claim.entityType !== "PROMOTER") continue;
    const entityType = claim.entityType;

    const tokens = await db
      .select({ id: claimTokens.id, email: claimTokens.email })
      .from(claimTokens)
      .where(
        and(
          eq(claimTokens.entityType, entityType),
          eq(claimTokens.entityId, claim.entityId),
          gt(claimTokens.expiresAt, now)
        )
      );
    const token = tokens.find((t) => sameOwnableDomain(normEmail(t.email), verifiedEmail));
    if (!token) continue; // stays PENDING → operator queue (OPE-599 digest)

    const entity = await loadEntity(db, entityType, claim.entityId);
    if (!entity) continue;
    if (entity.claimed && entity.ownerUserId !== userId) {
      await db
        .update(entityClaims)
        .set({ status: "DISPUTED", decidedAt: now })
        .where(eq(entityClaims.id, claim.id));
      continue;
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
      await recordClaimantAsPromoterContact(db, {
        promoterId: claim.entityId,
        userId,
        via: "invite-token",
        now,
      });
    }
    await db
      .insert(userRoles)
      .values({ userId, role: entityType, grantedAt: now, grantedBy: userId })
      .onConflictDoNothing();
    await db
      .update(entityClaims)
      .set({ status: "APPROVED", decidedAt: now, decidedBy: userId })
      .where(eq(entityClaims.id, claim.id));
    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action:
        entityType === "VENDOR" ? "vendor.claim_invite_redeem" : "promoter.claim_invite_redeem",
      actorUserId: userId,
      targetType: entityType.toLowerCase(),
      targetId: claim.entityId,
      payloadJson: JSON.stringify({
        via: "approvePendingInviteDomainClaims",
        tokenId: token.id,
        claimId: claim.id,
        domain: registrableDomainFromEmail(verifiedEmail),
      }),
      createdAt: now,
    });
    await db.delete(claimTokens).where(eq(claimTokens.id, token.id));
    await insertClaimApprovedNotification(db, {
      userId,
      entityType,
      entitySlug: entity.slug,
      entityName: decodeHtmlEntities(entity.name),
    });
    approvedClaims.push({ entityType, entitySlug: entity.slug });
  }

  return { approved: approvedClaims.length, approvedClaims };
}
