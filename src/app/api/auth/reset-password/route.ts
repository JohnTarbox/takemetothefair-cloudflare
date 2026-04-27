import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, passwordResetTokens } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const schema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: NextRequest) {
  const rateLimitResult = await checkRateLimit(request, "auth-reset-password");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();

  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 }
      );
    }

    const { token, password } = parsed.data;

    const record = await db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.token, token),
    });

    if (!record) {
      return NextResponse.json(
        { error: "This reset link is invalid or has already been used." },
        { status: 400 }
      );
    }

    if (record.expires.getTime() < Date.now()) {
      // Clean up expired token
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.token, token));
      return NextResponse.json(
        { error: "This reset link has expired. Please request a new one." },
        { status: 400 }
      );
    }

    const newHash = await hashPassword(password);

    await db
      .update(users)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(users.id, record.userId));

    // Consume the token so it can't be reused.
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.token, token));

    return NextResponse.json({ ok: true });
  } catch (error) {
    await logError(db, {
      message: "Reset password error",
      error,
      source: "api/auth/reset-password",
      request,
    });
    return NextResponse.json({ error: "An unexpected error occurred." }, { status: 500 });
  }
}
