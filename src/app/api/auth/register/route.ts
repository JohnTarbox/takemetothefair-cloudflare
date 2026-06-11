export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, userRoles, promoters, vendors, verificationTokens } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { createSlug, unsafeSlug } from "@/lib/utils";
import { and, eq, isNull } from "drizzle-orm";
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
  // Set when the signup originates from the public "Claim this listing"
  // CTA on /vendors/[slug]. The handler attempts to transfer ownership of
  // the placeholder vendor row instead of inserting a duplicate. Falls
  // back to insert if the slug is unknown / already claimed / owned by a
  // real (non-placeholder) account.
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
      claimVendorSlug,
      turnstileToken,
    } = validation.data;

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

    if (role === "PROMOTER" && companyName) {
      // promoters has no claimed/claimedAt/claimedBy columns (only
      // vendors does) — ownership is implied solely by userId match.
      await db.insert(promoters).values({
        id: crypto.randomUUID(),
        userId,
        companyName,
        slug: createSlug(companyName),
      });
    }

    if (role === "VENDOR" && businessName) {
      let claimedExistingRow = false;
      if (claimVendorSlug) {
        // Public "Claim this listing" CTA path: attempt to transfer the
        // placeholder vendor row to the new account instead of inserting
        // a duplicate. Safe to transfer only if:
        //   1. Vendor row exists, isn't soft-deleted, and isn't already claimed
        //   2. Its current userId points to a placeholder account
        //      (no passwordHash AND no emailVerified) — i.e. nobody else
        //      has actually logged in as the "owner" yet.
        const [target] = await db
          .select({ id: vendors.id, userId: vendors.userId, claimed: vendors.claimed })
          .from(vendors)
          .where(and(eq(vendors.slug, unsafeSlug(claimVendorSlug)), isNull(vendors.deletedAt)))
          .limit(1);
        if (target && target.claimed === false) {
          const [existingOwner] = await db
            .select({
              passwordHash: users.passwordHash,
              emailVerified: users.emailVerified,
            })
            .from(users)
            .where(eq(users.id, target.userId))
            .limit(1);
          const isPlaceholderOwner =
            !!existingOwner && !existingOwner.passwordHash && !existingOwner.emailVerified;
          if (isPlaceholderOwner) {
            // Race-safe: WHERE claimed = false ensures a concurrent claim
            // can't double-bind. SQLite/D1 doesn't expose rowsAffected on
            // .update() through Drizzle, so re-read after the write.
            await db
              .update(vendors)
              .set({
                userId,
                claimed: true,
                claimedAt: new Date(),
                claimedBy: userId,
              })
              .where(and(eq(vendors.id, target.id), eq(vendors.claimed, false)));
            const [confirm] = await db
              .select({ userId: vendors.userId })
              .from(vendors)
              .where(eq(vendors.id, target.id))
              .limit(1);
            if (confirm?.userId === userId) {
              claimedExistingRow = true;
            }
          }
        }
      }
      if (!claimedExistingRow) {
        // Same rationale as the PROMOTER branch — signup minted this row
        // for this user, so mark it claimed now. Otherwise the vendor
        // page hides the Claim CTA (isOwner=true) but also never
        // confirms ownership (claimed=0).
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
