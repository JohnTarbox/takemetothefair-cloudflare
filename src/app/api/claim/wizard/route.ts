export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import { withAuth } from "@/lib/api/with-auth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { resolveClaimInWizard } from "@/lib/claims/resolve-claim-in-wizard";
import { parseGaClientId } from "@/lib/ga4-measurement-protocol";
import {
  trackClaimVerificationAttemptedServer,
  trackClaimCompletedServer,
  type ClaimMethod,
} from "@/lib/analytics/claim-funnel";

/**
 * Claim WIZARD verification endpoint — OPE-64.
 *
 * Auth-gated (withAuth). Evaluates the verification ladder for the signed-in
 * user against the target listing and returns the outcome for the UI to render.
 *
 * SECURITY: `emailVerified` is loaded from the user's DB record here and passed
 * into the resolver — NEVER trust a client-supplied verified flag. Instant
 * approval (email/domain match) only happens when the DB says the email is
 * verified; otherwise the resolver records PENDING and defers to the
 * email-verification callback.
 */
const bodySchema = z.object({
  entityType: z.enum(["VENDOR", "PROMOTER"]),
  slug: z.string().min(1),
});

export const POST = withAuth(async ({ request, db, session }) => {
  const limit = await checkRateLimit(request, "claim-wizard");
  if (!limit.allowed) return rateLimitResponse(limit);

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid request" },
      { status: 400 }
    );
  }
  const { entityType, slug } = parsed.data;

  // Load the account email + verification state from the DB — the source of
  // truth. Never trust the client for the verified flag.
  const [user] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 401 });
  }

  const result = await resolveClaimInWizard(db, {
    entityType,
    slug,
    userId: session.user.id,
    userEmail: user.email,
    emailVerified: !!user.emailVerified,
  });

  if (result.outcome === "entity_not_found") {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  // Best-effort funnel analytics (server-side, ad-block-proof). Never block.
  try {
    const clientId = parseGaClientId(request.headers.get("cookie")) ?? crypto.randomUUID();
    const method = (result.method ?? "EVIDENCE") as ClaimMethod;
    await trackClaimVerificationAttemptedServer({ clientId, entityType, entitySlug: slug, method });
    if (result.outcome === "approved") {
      await trackClaimCompletedServer({ clientId, entityType, entitySlug: slug, method });
    }
  } catch {
    // analytics is best-effort
  }

  return NextResponse.json({
    outcome: result.outcome,
    method: result.method ?? null,
    entityType: result.entityType,
    entityName: result.entityName ?? null,
    entitySlug: result.entitySlug ?? slug,
  });
});
