export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { recordRegistrationAttempt } from "@/lib/auth/record-registration-attempt";
import { REGISTRATION_ATTEMPT_OUTCOME } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/auth/normalize-email";
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
import {
  findNameCollision,
  nameCollisionMessage,
  isUniqueConstraintError,
  type NameCollision,
} from "@/lib/claims/signup-name-collision";
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

/**
 * 409 for a signup that collided with an existing listing.
 *
 * `claimAvailable` is what the register form needs to offer the claim link.
 * Kept structured rather than baked into the message string so the client can
 * render a real link instead of parsing prose.
 */
/**
 * Undo the half-made account.
 *
 * The pre-flight above catches every collision we have actually observed. This
 * covers the narrow race where two signups with the same business name pass it
 * together — one wins the UNIQUE index, the other must not be left owning an
 * account it was told had failed to be created. D1 gives us no transaction
 * across these statements, so the compensating delete IS the rollback.
 *
 * Fail-soft: if the cleanup itself fails we still return the 409. A stranded
 * row is bad; a stranded row plus a 500 is worse, and the caller has already
 * been told the name is the problem.
 */
async function rollbackHalfCreatedAccount(db: ReturnType<typeof getCloudflareDb>, userId: string) {
  try {
    await db.delete(userRoles).where(eq(userRoles.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  } catch {
    // Swallowed on purpose — see above.
  }
}

function nameCollisionResponse(collision: NameCollision) {
  return NextResponse.json(
    {
      error: nameCollisionMessage(collision),
      claimAvailable: {
        entityType: collision.entityType,
        slug: collision.slug,
        name: collision.name,
        claimUrl: collision.claimUrl,
      },
    },
    { status: 409 }
  );
}

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
      // OPE-634 — capture the attempt before the refusal, while the address the
      // person typed still exists. Fail-soft; see the helper.
      await recordRegistrationAttempt(db, {
        email: (body as { email?: unknown })?.email,
        outcome: REGISTRATION_ATTEMPT_OUTCOME.VALIDATION,
        detail: issues[0]?.message ?? null,
      });
      return NextResponse.json(
        { error: issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const {
      email: rawEmail,
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
      // OPE-634 — THE case this table exists for. When OPE-150 broke the widget,
      // everyone who reached exactly here vanished without trace; the one person
      // we know about is the one who happened to email support@. The address is
      // already parsed at this point, so the refusal is recoverable as a person
      // rather than as a page view.
      await recordRegistrationAttempt(db, {
        email: rawEmail,
        outcome: REGISTRATION_ATTEMPT_OUTCOME.TURNSTILE,
        detail: turnstileResult.errorCodes?.join(",") ?? null,
      });
      return NextResponse.json(
        { error: getTurnstileErrorMessage(turnstileResult.errorCodes) },
        { status: 400 }
      );
    }

    // OPE-601 — the identity key is case-insensitive, so the duplicate check
    // and every subsequent use of the address run on the normalized form.
    // Unnormalized, `Admin@x.com` sailed past this check while `admin@x.com`
    // already existed, and the insert below then created the second account.
    const email = normalizeEmail(rawEmail);
    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (existingUser.length > 0) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 400 }
      );
    }

    // OPE-573 — resolve a business-name collision BEFORE creating anything.
    //
    // Ordering is the whole fix. `users` + `user_roles` are inserted below,
    // then the vendor/promoter row; there is no transaction spanning them, so
    // a UNIQUE failure on the entity slug used to leave a REAL account behind
    // with no listing. The person saw "An error occurred during registration"
    // and their retry hit "An account with this email already exists" — locked
    // out of a signup that had half-succeeded. Three accounts are in that state
    // on prod; see @/lib/claims/signup-name-collision.
    //
    // Checked only for the create-a-new-listing shape. A claim-funnel signup
    // (claimSlug present) is ALREADY heading at an existing listing and must
    // not be blocked for colliding with the very row it means to claim.
    if (!claimSlug) {
      const collisionName =
        role === "VENDOR" ? businessName : role === "PROMOTER" ? companyName : undefined;
      if (collisionName) {
        const collision = await findNameCollision(
          db,
          role === "VENDOR" ? "VENDOR" : "PROMOTER",
          collisionName
        );
        if (collision) {
          // Record it as a HANDLED event, per the ticket's acceptance. Two
          // reasons this is not just noise:
          //  1. Without it the fix is invisible. The old failure at least left
          //     an `error` row; a clean 409 that logged nothing would make a
          //     recurring collision look like it had stopped happening.
          //  2. It is a demand signal. Every one of these is a vendor already
          //     in the directory trying to sign up — the claim funnel OPE-59
          //     measured at ~0 conversion. Knowing how often this fires, and
          //     whether a claim follows, is the only way to tell whether the
          //     claim link works.
          await logError(db, {
            level: "warn",
            message: "OPE-573 signup name collision — routed to claim flow",
            source: "api/auth/register:name-collision",
            context: {
              entityType: collision.entityType,
              slug: collision.slug,
              claimed: collision.claimed,
            },
          });
          return nameCollisionResponse(collision);
        }
      }
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
        try {
          await db.insert(promoters).values({
            id: crypto.randomUUID(),
            userId,
            companyName,
            slug: createSlug(companyName),
            claimed: true,
            claimedAt: new Date(),
            claimedBy: userId,
          });
        } catch (slugErr) {
          // Same shape as the vendor branch — promoters.slug carries the same
          // notNull().unique() and had the same unhandled collision.
          if (!isUniqueConstraintError(slugErr)) throw slugErr;
          await rollbackHalfCreatedAccount(db, userId);
          const collision = await findNameCollision(db, "PROMOTER", companyName);
          await logError(db, {
            level: "warn",
            message: "OPE-573 promoter slug collision resolved at insert (pre-flight raced)",
            source: "api/auth/register:slug-collision",
            context: { companyName, slug: collision?.slug ?? null },
          });
          return collision
            ? nameCollisionResponse(collision)
            : NextResponse.json(
                { error: "That organization name is already in use. Please try again." },
                { status: 409 }
              );
        }
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
        try {
          await db.insert(vendors).values({
            id: vendorId,
            userId,
            businessName,
            slug: createSlug(businessName),
            claimed: true,
            claimedAt: new Date(),
            claimedBy: userId,
          });
        } catch (slugErr) {
          // OPE-573 backstop — the pre-flight lost a race. Undo the account and
          // answer with the same 409 the pre-flight would have sent, rather than
          // letting this reach the outer catch as a 500 with a raw driver string.
          if (!isUniqueConstraintError(slugErr)) throw slugErr;
          await rollbackHalfCreatedAccount(db, userId);
          const collision = await findNameCollision(db, "VENDOR", businessName);
          await logError(db, {
            level: "warn",
            message: "OPE-573 vendor slug collision resolved at insert (pre-flight raced)",
            source: "api/auth/register:slug-collision",
            context: { businessName, slug: collision?.slug ?? null },
          });
          return collision
            ? nameCollisionResponse(collision)
            : NextResponse.json(
                { error: "That business name is already in use. Please try again." },
                { status: 409 }
              );
        }

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
