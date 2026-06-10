import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, verificationTokens } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";
import { emailVerificationTemplate } from "@/lib/email/templates";

export const runtime = "edge";

const schema = z.object({ email: z.string().email().optional() });

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function POST(request: NextRequest) {
  const rateLimitResult = await checkRateLimit(request, "auth-verify-email-send");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    const emailFromBody = parsed.success ? parsed.data.email : undefined;

    // Prefer the authenticated session; fall back to a provided email for the
    // immediate-post-signup case where the session cookie hasn't fully synced.
    const session = await auth();
    const targetEmail = (session?.user?.email ?? emailFromBody ?? "").toLowerCase().trim();

    if (!targetEmail) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, targetEmail),
    });

    // Generic success to avoid leaking account existence
    if (!user) {
      return NextResponse.json({ ok: true });
    }

    if (user.emailVerified) {
      return NextResponse.json({ ok: true, alreadyVerified: true });
    }

    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const expires = new Date(Date.now() + TOKEN_TTL_MS);

    await db.insert(verificationTokens).values({
      identifier: user.email,
      token,
      expires,
    });

    const verifyUrl = `${getSiteUrl()}/verify-email/${token}`;
    const tpl = emailVerificationTemplate({ verifyUrl, name: user.name });

    // Enqueue rather than direct-send. The queue consumer (MCP worker)
    // delivers via CF Email Sending and handles retries (max_retries=3
    // then DLQ). Direct sendEmail() bypassed the queue and stubbed
    // silently when RESEND_API_KEY was absent on Pages — exactly the
    // gap that produced the 2026-04-25 → 2026-05-24 silent outage.
    try {
      await enqueueEmail({
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        source: "auth.send-verification",
      });
    } catch (e) {
      await logError(db, {
        level: "warn",
        message: "Failed to enqueue verification email",
        error: e,
        source: "api/auth/send-verification",
        context: { email: targetEmail },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    await logError(db, {
      message: "Send verification error",
      error,
      source: "api/auth/send-verification",
      request,
    });
    return NextResponse.json({ error: "An unexpected error occurred." }, { status: 500 });
  }
}
