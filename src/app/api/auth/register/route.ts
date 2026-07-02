export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, userRoles, promoters, vendors, verificationTokens } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { createSlug } from "@/lib/utils";
import { eq } from "drizzle-orm";
import {
  resolveClaimAtSignup,
  type ClaimOutcome,
  type ClaimEntityType,
} from "@/lib/claims/resolve-claim-at-signup";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { verifyTurnstileToken, getTurnstileErrorMessage } from "@/lib/turnstile";
import { getSiteUrl } from "@/lib/email/send";
import { emailVerificationTemplate } from "@/lib/email/templates";
import { enqueueEmail } from "@/lib/queues/producers";

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  role: z.enum(["USER", "PROMOTER", "VENDOR"]).optional().default("USER"),
  companyName: z.string().optional(),
  businessName: z.string().optional(),
  // Set when the signup originates from a public "Claim this listing" CTA
  // (/vendors/[slug] or /promoters/[slug]). The slug of the entity being
  // claimed. `claimSlug` is the canonical field; `claimVendorSlug` is kept as
  // a backward-compat alias for any in-flight vendor clients. The claim itself
  // is resolved SAFELY post-signup by resolveClaimAtSignup — a match on the
  // listing's contact email auto-approves; everything else is logged PENDING
  // (never an unverified auto-transfer). See @/lib/claims/resolve-claim-at-signup.
  claimSlug: z.string().optional(),
  claimVendorSlug: z.string().optional(),
  turnstileToken: z.string().optional(), // Turnstile verification token
});

export async function POST(request: NextRequest) {
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "auth-register");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();
  try {
    const body = await request.json();
    const validation = registerSchema.safeParse(body);

    if (!validation.success) {
      const issues = validation.error.issues;
      return NextResponse.json(
        { error: issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const {
      email,
      password,
      name,
      role,
      companyName,
      businessName,
      claimSlug: claimSlugField,
      claimVendorSlug,
      turnstileToken,
    } = validation.data;
    // Canonical claim slug — accept the new `claimSlug` field, fall back to the
    // legacy `claimVendorSlug` alias.
    const claimSlug = claimSlugField ?? claimVendorSlug;

    // Verify Turnstile token (required for all registration attempts)
    const turnstileResult = await verifyTurnstileToken(turnstileToken || "", request);
    if (!turnstileResult.success) {
      return NextResponse.json(
        { error: getTurnstileErrorMessage(turnstileResult.errorCodes) },
        { status: 400 }
      );
    }

    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (existingUser.length > 0) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();

    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      name,
      role,
    });

    // Mirror the chosen role into user_roles so dual-role-aware code
    // paths see this grant. userId is freshly minted above, so no
    // (user_id, role) conflict is possible — no onConflictDoNothing
    // needed here. Claim endpoints DO need it for idempotent re-claims.
    await db.insert(userRoles).values({ userId, role, grantedAt: new Date() });

    // Claim outcome, surfaced in the response so the client can route the user
    // to the right post-signup surface (success widget / dispute / evidence).
    let claim: { outcome: ClaimOutcome; entityType: ClaimEntityType } | undefined;

    // Two distinct signup shapes per entity role:
    //  (a) claim funnel (claimSlug present): resolve the claim SAFELY against an
    //      EXISTING listing. resolveClaimAtSignup transfers ownership ONLY on a
    //      contact-email match; otherwise it logs the attempt (PENDING/DISPUTED)
    //      and never creates a duplicate row. We deliberately do NOT insert a
    //      fresh listing here — the claim is against the entity identified by
    //      slug, not a new one.
    //  (b) plain signup (no claimSlug): the user is creating THEIR OWN new
    //      listing, so we mint + mark it claimed (they are the author; this is
    //      not claiming someone else's listing).
    if (role === "PROMOTER") {
      if (claimSlug) {
        const res = await resolveClaimAtSignup(db, {
          entityType: "PROMOTER",
          slug: claimSlug,
          userId,
          userEmail: email,
        });
        claim = { outcome: res.outcome, entityType: res.entityType };
      } else if (companyName) {
        await db.insert(promoters).values({
          id: crypto.randomUUID(),
          userId,
          companyName,
          slug: createSlug(companyName),
          claimed: true,
          claimedAt: new Date(),
          claimedBy: userId,
        });
      }
    }

    if (role === "VENDOR") {
      if (claimSlug) {
        const res = await resolveClaimAtSignup(db, {
          entityType: "VENDOR",
          slug: claimSlug,
          userId,
          userEmail: email,
        });
        claim = { outcome: res.outcome, entityType: res.entityType };
      } else if (businessName) {
        await db.insert(vendors).values({
          id: crypto.randomUUID(),
          userId,
          businessName,
          slug: createSlug(businessName),
          claimed: true,
          claimedAt: new Date(),
          claimedBy: userId,
        });
      }
    }

    // Fire-and-forget email verification. If the send fails (e.g. no email
    // provider yet), the token is still recorded and the user can request a
    // resend from the in-app banner.
    try {
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.insert(verificationTokens).values({
        identifier: email,
        token,
        expires,
      });
      const tpl = emailVerificationTemplate({
        verifyUrl: `${getSiteUrl()}/verify-email/${token}`,
        name,
      });
      // Enqueue rather than sending synchronously — the queue consumer
      // (MCP worker) handles Resend's HTTP round-trip. User gets the
      // signup-success response without waiting on email delivery.
      await enqueueEmail({
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        source: "auth.register",
      });
    } catch (mailErr) {
      // Don't block signup on email issues
      await logError(db, {
        level: "warn",
        message: "Failed to dispatch verification email at signup",
        error: mailErr,
        source: "api/auth/register:verification",
        context: { email },
      });
    }

    return NextResponse.json(
      {
        message: "Account created successfully",
        user: {
          id: userId,
          email,
          name,
          role,
        },
        // Present only for claim-funnel signups. The client maps `outcome`
        // to a post-signup redirect (success widget / dispute / evidence page).
        ...(claim ? { claim } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    await logError(db, {
      message: "Registration error",
      error,
      source: "api/auth/register",
      request,
    });
    return NextResponse.json({ error: "An error occurred during registration" }, { status: 500 });
  }
}
