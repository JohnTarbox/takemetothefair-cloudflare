export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, userRoles, promoters, vendors, verificationTokens } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { isBlockedSsrfHost } from "@takemetothefair/site-fetch";
import { createSlug } from "@/lib/utils";
import { eq } from "drizzle-orm";
import {
  resolveClaimAtSignup,
  type ClaimOutcome,
  type ClaimEntityType,
  type ResolveClaimAtSignupResult,
} from "@/lib/claims/resolve-claim-at-signup";
import { recordClaimEvidence } from "@/lib/claims/claim-evidence";
import { parseGaClientId } from "@/lib/ga4-measurement-protocol";
import {
  trackClaimAccountCreatedServer,
  trackClaimVerificationAttemptedServer,
} from "@/lib/analytics/claim-funnel";
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
  // OPE-237 — the vendor's self-declared website. Optional; see the register
  // form for why it is never required.
  //
  // Rejected at the BOUNDARY if it points at an internal host. The
  // corroboration pass fetches this URL later, so accepting
  // `http://169.254.169.254/…` here would store a stored-SSRF payload that an
  // admin action detonates. Defence in depth — the pass guards every redirect
  // hop too — but not storing a hostile URL at all is strictly better than
  // refusing to fetch it afterwards.
  website: z
    .string()
    .trim()
    .url()
    .refine(
      (v) => {
        try {
          const u = new URL(v);
          return (
            (u.protocol === "http:" || u.protocol === "https:") && !isBlockedSsrfHost(u.hostname)
          );
        } catch {
          return false;
        }
      },
      { message: "Enter a public website address" }
    )
    .optional(),
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
      website,
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
    // Full resolve result retained for OPE-66 claim-funnel GA4 events (fired
    // below, once, for either role branch).
    let claimResult: ResolveClaimAtSignupResult | undefined;

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
        claimResult = res;
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
        claimResult = res;
      } else if (businessName) {
        const vendorId = crypto.randomUUID();
        await db.insert(vendors).values({
          id: vendorId,
          userId,
          businessName,
          slug: createSlug(businessName),
          claimed: true,
          claimedAt: new Date(),
          claimedBy: userId,
        });

        // OPE-237 — realness screen. THIS is the live claim path: verified
        // against prod 2026-07-27, the dedicated claim endpoints have logged
        // zero actions ever, while 13 of 14 claimed vendors were minted right
        // here. Runs inline because the coherence pass is pure string work with
        // no network; fail-soft because a registration must never fail over an
        // advisory screen. Persistent failure surfaces via the
        // `vendor-claim-evidence` heartbeat probe rather than silently.
        try {
          await recordClaimEvidence(db, {
            vendorId,
            userId,
            claimantName: name,
            businessName,
            email,
            // Always false here — verification lands minutes-to-hours later and
            // re-scores. The signup-time score is deliberately pessimistic.
            emailVerified: false,
            // OPE-237 — was hard-coded `null`, which is why the corroboration
            // dimension read UNAVAILABLE on all 35 rows accumulated since
            // 2026-07-28. Adding the form field alone would have changed
            // nothing: this line discarded it before the screen ever saw it.
            website: website ?? null,
            description: null,
          });
        } catch (evidenceErr) {
          await logError(db, {
            level: "warn",
            message: "OPE-237 realness screen failed at signup",
            error: evidenceErr,
            source: "api/auth/register:claim-evidence",
            context: { vendorId, businessName },
          });
        }
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

    // OPE-66 — server-side claim-funnel GA4 events (ad-block-proof, `_server`
    // suffix). Only for claim-funnel signups whose slug resolved to an entity
    // (entity_not_found has no slug/id worth attributing). `claimSlug` IS the
    // `entity_id` custom dim (public slug), matching the ENG1.8 convention.
    if (claimSlug && claimResult && claimResult.outcome !== "entity_not_found") {
      const clientId = parseGaClientId(request.headers.get("cookie")) ?? crypto.randomUUID();
      const claimEntityType = claimResult.entityType;
      await trackClaimAccountCreatedServer({
        clientId,
        entityType: claimEntityType,
        entitySlug: claimSlug,
      });
      // `pending_verification` = rung-1 email match: the account email matched
      // the listing's contact address, so the user is routed to verify their
      // email — that email-verification step IS the EMAIL_MATCH attempt.
      if (claimResult.outcome === "pending_verification") {
        await trackClaimVerificationAttemptedServer({
          clientId,
          entityType: claimEntityType,
          entitySlug: claimSlug,
          method: "EMAIL_MATCH",
        });
      }
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
