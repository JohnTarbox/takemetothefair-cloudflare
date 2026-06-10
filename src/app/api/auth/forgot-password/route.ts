import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, passwordResetTokens } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";
import { passwordResetTemplate } from "@/lib/email/templates";

export const runtime = "edge";

const schema = z.object({ email: z.string().email() });

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(request: NextRequest) {
  const rateLimitResult = await checkRateLimit(request, "auth-forgot-password");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();

  // Always return the same success payload regardless of whether the email
  // exists — this prevents account enumeration.
  const GENERIC_OK = NextResponse.json({ ok: true });

  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return GENERIC_OK;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    // Only issue a reset for accounts that have a password set (i.e. not
    // pure OAuth accounts). Still return generic OK to preserve enumeration safety.
    if (!user || !user.passwordHash) {
      return GENERIC_OK;
    }

    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const expires = new Date(Date.now() + TOKEN_TTL_MS);

    await db.insert(passwordResetTokens).values({
      token,
      userId: user.id,
      expires,
    });

    const resetUrl = `${getSiteUrl()}/reset-password/${token}`;
    const tpl = passwordResetTemplate({ resetUrl, name: user.name });

    // Enqueue rather than direct-send. The queue consumer (MCP worker)
    // delivers via CF Email Sending and retries on transient failure.
    // Direct sendEmail() bypassed the queue and silently stubbed when
    // RESEND_API_KEY was absent on Pages (2026-04-25 → 2026-05-24 outage).
    try {
      await enqueueEmail({
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        source: "auth.forgot-password",
      });
    } catch (e) {
      await logError(db, {
        level: "warn",
        message: "Failed to enqueue password reset email",
        error: e,
        source: "api/auth/forgot-password",
        context: { email },
      });
      // Still return GENERIC_OK — token is in DB, queue error is admin-visible
    }

    return GENERIC_OK;
  } catch (error) {
    await logError(db, {
      message: "Forgot password error",
      error,
      source: "api/auth/forgot-password",
      request,
    });
    return GENERIC_OK; // never reveal errors to clients
  }
}
