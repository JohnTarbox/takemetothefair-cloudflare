import { and, eq } from "drizzle-orm";
import { users, verificationTokens } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import {
  approvePendingEmailMatchClaims,
  type ClaimEntityType,
} from "@/lib/claims/resolve-claim-at-signup";
import { approvePendingDomainMatchClaims } from "@/lib/claims/resolve-claim-in-wizard";
import type { Database } from "@/lib/db";

/**
 * Validate a verification token and, if valid, mark the user's email as
 * verified and consume the token (single-use).
 *
 * Shape is a discriminated union so callers can tailor the UX to the specific
 * failure mode (expired vs. unknown token).
 */
export async function validateAndConsumeVerificationToken(
  db: ReturnType<typeof getCloudflareDb>,
  token: string
): Promise<
  | {
      ok: true;
      email: string;
      /** Claims auto-approved by this verification (rung-1 email match) — the
       *  verify-email surface fires claim_completed_server for each (OPE-66). */
      approvedClaims: Array<{ entityType: ClaimEntityType; entitySlug: string }>;
    }
  | { ok: false; reason: "not_found" | "expired" }
> {
  const record = await db.query.verificationTokens.findFirst({
    where: eq(verificationTokens.token, token),
  });

  if (!record) {
    return { ok: false, reason: "not_found" };
  }

  if (record.expires.getTime() < Date.now()) {
    await db
      .delete(verificationTokens)
      .where(
        and(
          eq(verificationTokens.identifier, record.identifier),
          eq(verificationTokens.token, token)
        )
      );
    return { ok: false, reason: "expired" };
  }

  await db
    .update(users)
    .set({ emailVerified: new Date(), updatedAt: new Date() })
    .where(eq(users.email, record.identifier));

  await db
    .delete(verificationTokens)
    .where(
      and(eq(verificationTokens.identifier, record.identifier), eq(verificationTokens.token, token))
    );

  // OPE-59 SECURITY — verifying the email PROVES inbox control, which is the
  // proof rung-1 email-match requires. Auto-approve any PENDING email-match
  // claims this user made at signup (resolveClaimAtSignup deferred them here).
  // Best-effort: a failure must NOT block email verification itself — the claim
  // simply stays PENDING (recoverable via the evidence flow / re-verify).
  let approvedClaims: Array<{ entityType: ClaimEntityType; entitySlug: string }> = [];
  try {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, record.identifier))
      .limit(1);
    if (u) {
      const res = await approvePendingEmailMatchClaims(
        db as unknown as Database,
        u.id,
        record.identifier
      );
      approvedClaims = res.approvedClaims;
      // OPE-64 — the domain-match analog. Verifying the email PROVES inbox
      // control at the matched registrable domain, the proof rung-2 requires.
      // approvePendingDomainMatchClaims RE-VALIDATES the domain match against
      // the entity's CURRENT website before transferring ownership (the website
      // could have changed since the wizard recorded PENDING). Best-effort.
      const domainRes = await approvePendingDomainMatchClaims(
        db as unknown as Database,
        u.id,
        record.identifier
      );
      approvedClaims = [...approvedClaims, ...domainRes.approvedClaims];
    }
  } catch {
    // swallow — verification succeeded; claim approval is retryable out-of-band.
  }

  return { ok: true, email: record.identifier, approvedClaims };
}
