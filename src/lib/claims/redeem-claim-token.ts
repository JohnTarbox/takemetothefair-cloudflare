/**
 * Cold-invite redemption core — OPE-67 (UI wiring: OPE-64).
 *
 * MAGIC-LINK TRUST MODEL
 * ----------------------
 * `create_claim_invite` (mcp-server) mints a single-use, 14-day token bound to
 * a specific (entityType, entityId, email) and emails a magic link containing
 * the RAW token to that contact address. Clicking the link is the "inbox proof"
 * — but a link can be forwarded, so a click alone is NOT sufficient to transfer
 * ownership. This core adds a second factor: the REDEEMING ACCOUNT'S email
 * (lowercased) must equal the token's `email` (lowercased). Ownership only
 * transfers when both hold — the invite reached that address AND the account
 * signing in owns that address.
 *
 * Because entity_claims.userId is NOT NULL, no entity_claims row exists at
 * invite time; this is where the deferred attempt row is finally written (now
 * that a user account exists), as method=INVITE_TOKEN, status=APPROVED.
 *
 * This is the side-effecting core ONLY — it is NOT wired into the register route
 * or any page this session (that is OPE-64). It is unit-tested directly against
 * better-sqlite3, exactly like resolve-claim-at-signup.ts. A full security pass
 * over the live redemption path (rate limiting, funnel edge cases, GA4) lands
 * with OPE-64.
 *
 * SECURITY invariants (mirror the rest of the claim program — do NOT regress):
 *   - No silent takeover: an entity already claimed by a DIFFERENT user refuses
 *     (already_claimed_by_other) and touches nothing.
 *   - Ownership transfer is guarded by claimed=false (idempotent).
 *   - Single use: the token row is deleted on successful redemption.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  vendors,
  promoters,
  users,
  userRoles,
  entityClaims,
  claimTokens,
  adminActions,
} from "@/lib/db/schema";
import { decodeHtmlEntities } from "@/lib/utils";

export type RedeemEntityType = "VENDOR" | "PROMOTER";

export interface RedeemResult {
  ok: boolean;
  reason?: "invalid" | "expired" | "email_mismatch" | "entity_missing" | "already_claimed_by_other";
  entityType?: RedeemEntityType;
  entitySlug?: string;
  entityName?: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

function normEmail(e: string | null | undefined): string {
  return (e ?? "").trim().toLowerCase();
}

export async function redeemClaimToken(
  db: Database,
  { rawToken, userId }: { rawToken: string; userId: string }
): Promise<RedeemResult> {
  const now = new Date();

  // 1. Look up the token by hash.
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
  if (!token) return { ok: false, reason: "invalid" };
  if (token.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  // 2. Load the redeeming account; SECURITY — its email must equal the token's.
  const [user] = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { ok: false, reason: "invalid" };

  const tokenEmail = normEmail(token.email);
  if (tokenEmail.length === 0 || tokenEmail !== normEmail(user.email)) {
    return { ok: false, reason: "email_mismatch" };
  }

  // Cold invites are only ever minted for VENDOR/PROMOTER; anything else has no
  // claim funnel — treat as a missing entity defensively.
  if (token.entityType !== "VENDOR" && token.entityType !== "PROMOTER") {
    return { ok: false, reason: "entity_missing" };
  }
  const entityType = token.entityType;

  // 3. Load the entity.
  let entity:
    | { ownerUserId: string | null; claimed: boolean; name: string; slug: string }
    | undefined;
  if (entityType === "VENDOR") {
    const [row] = await db
      .select({
        ownerUserId: vendors.userId,
        claimed: vendors.claimed,
        name: vendors.businessName,
        slug: vendors.slug,
      })
      .from(vendors)
      .where(eq(vendors.id, token.entityId))
      .limit(1);
    entity = row ? { ...row, slug: row.slug as unknown as string } : undefined;
  } else {
    const [row] = await db
      .select({
        ownerUserId: promoters.userId,
        claimed: promoters.claimed,
        name: promoters.companyName,
        slug: promoters.slug,
      })
      .from(promoters)
      .where(eq(promoters.id, token.entityId))
      .limit(1);
    entity = row ? { ...row, slug: row.slug as unknown as string } : undefined;
  }
  if (!entity) return { ok: false, reason: "entity_missing" };

  // No silent takeover.
  if (entity.claimed && entity.ownerUserId !== userId) {
    return { ok: false, reason: "already_claimed_by_other" };
  }

  // 4. Transfer ownership (guarded), grant role, write the deferred claim row.
  if (entityType === "VENDOR") {
    await db
      .update(vendors)
      .set({ userId, claimed: true, claimedAt: now, claimedBy: userId })
      .where(and(eq(vendors.id, token.entityId), eq(vendors.claimed, false)));
  } else {
    await db
      .update(promoters)
      .set({ userId, claimed: true, claimedAt: now, claimedBy: userId })
      .where(and(eq(promoters.id, token.entityId), eq(promoters.claimed, false)));
  }

  await db
    .insert(userRoles)
    .values({ userId, role: entityType, grantedAt: now, grantedBy: userId })
    .onConflictDoNothing();

  await db.insert(entityClaims).values({
    id: crypto.randomUUID(),
    entityType,
    entityId: token.entityId,
    userId,
    method: "INVITE_TOKEN",
    status: "APPROVED",
    createdAt: now,
    decidedAt: now,
    decidedBy: userId,
  });

  // Clicking the invite proves control of token.email, which equals the
  // account email — so mark the account verified if it isn't already.
  if (!user.emailVerified) {
    await db.update(users).set({ emailVerified: now }).where(eq(users.id, userId));
  }

  await db.insert(adminActions).values({
    id: crypto.randomUUID(),
    action: entityType === "VENDOR" ? "vendor.claim_invite_redeem" : "promoter.claim_invite_redeem",
    actorUserId: userId,
    targetType: entityType.toLowerCase(),
    targetId: token.entityId,
    payloadJson: JSON.stringify({ via: "redeemClaimToken", tokenId: token.id, email: tokenEmail }),
    createdAt: now,
  });

  // 5. Single use — consume the token.
  await db.delete(claimTokens).where(eq(claimTokens.id, token.id));

  return {
    ok: true,
    entityType,
    entitySlug: entity.slug,
    entityName: decodeHtmlEntities(entity.name),
  };
}
