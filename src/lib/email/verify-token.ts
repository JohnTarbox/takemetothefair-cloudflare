import { and, eq } from "drizzle-orm";
import { users, verificationTokens } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";
import {
  approvePendingEmailMatchClaims,
  type ClaimEntityType,
} from "@/lib/claims/resolve-claim-at-signup";
import { approvePendingDomainMatchClaims } from "@/lib/claims/resolve-claim-in-wizard";
import { rescoreEvidenceAfterVerification } from "@/lib/claims/claim-evidence";
import type { Database } from "@/lib/db";
import { logError } from "@/lib/logger";

/** error_logs `source` for every failure this module swallows (OPE-1374). */
export const VERIFY_TOKEN_LOG_SOURCE = "email-verify-token";

/**
 * A claim auto-approval pass failed after the token was consumed. The claim
 * stays PENDING with no retry, so this row is the only trace (OPE-1374).
 */
async function logClaimApprovalFailure(
  db: ReturnType<typeof getCloudflareDb>,
  stage: "user-lookup" | "email-match" | "domain-match",
  userId: string | undefined,
  error: unknown
): Promise<void> {
  await logError(db as unknown as Parameters<typeof logError>[0], {
    message: `Claim auto-approval (${stage}) failed after email verification; claim stays PENDING`,
    error,
    source: VERIFY_TOKEN_LOG_SOURCE,
    context: { stage, userId: userId ?? null },
  });
}

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
  // stays PENDING. NOTHING retries it (the token is consumed above), so each
  // failure is logged to error_logs with the user id and the pass that threw
  // (OPE-1374) — it surfaces through the fault ledger instead of vanishing.
  //
  // The two passes are independent: a throw in email-match must not skip
  // domain-match, so each has its own try/catch.
  const approvedClaims: Array<{ entityType: ClaimEntityType; entitySlug: string }> = [];
  let userId: string | undefined;
  try {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, record.identifier))
      .limit(1);
    userId = u?.id;
  } catch (error) {
    await logClaimApprovalFailure(db, "user-lookup", undefined, error);
  }

  if (userId) {
    try {
      const res = await approvePendingEmailMatchClaims(
        db as unknown as Database,
        userId,
        record.identifier
      );
      approvedClaims.push(...res.approvedClaims);
    } catch (error) {
      await logClaimApprovalFailure(db, "email-match", userId, error);
    }

    // OPE-64 — the domain-match analog. Verifying the email PROVES inbox
    // control at the matched registrable domain, the proof rung-2 requires.
    // approvePendingDomainMatchClaims RE-VALIDATES the domain match against
    // the entity's CURRENT website before transferring ownership (the website
    // could have changed since the wizard recorded PENDING). Best-effort.
    try {
      const domainRes = await approvePendingDomainMatchClaims(
        db as unknown as Database,
        userId,
        record.identifier
      );
      approvedClaims.push(...domainRes.approvedClaims);
    } catch (error) {
      await logClaimApprovalFailure(db, "domain-match", userId, error);
    }
  }

  // OPE-237 — re-score the realness evidence now that inbox control is proven.
  // The signup-time score is deliberately pessimistic (emailVerified is always
  // false at that instant; verification lands minutes-to-hours later), so
  // without this every self-registered vendor would sit permanently 25 points
  // below its true score and over-report as NEEDS_REVIEW.
  //
  // Coherence only — no fetch. Verification is a user-facing round-trip and
  // must not wait on someone else's web server; web corroboration is the
  // admin-triggered pass.
  //
  // Best-effort, like the claim approval above: an advisory screen must never
  // fail a verification.
  try {
    await rescoreEvidenceAfterVerification(db, record.identifier);
  } catch (error) {
    // The evidence row keeps its pessimistic score; the reviewer still sees
    // the (unverified) reason line, which is safe-by-default. Logged so a
    // persistent failure is visible (OPE-1374).
    await logError(db as unknown as Parameters<typeof logError>[0], {
      message: "Evidence re-score after email verification failed",
      error,
      source: VERIFY_TOKEN_LOG_SOURCE,
      level: "warn",
      context: { stage: "rescore-evidence", userId: userId ?? null },
    });
  }

  return { ok: true, email: record.identifier, approvedClaims };
}
