export const dynamic = "force-dynamic";
import "@/lib/validations/zod-locale";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, passwordResetTokens } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hashResetToken } from "@/lib/auth/password-reset-token";

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

    // OPE-1378 (AUTH8) — tokens are stored as SHA-256(token), and the row is
    // consumed in ONE statement (DELETE … RETURNING). The old read-then-delete
    // let two concurrent requests both pass the read; now exactly one gets the
    // row back and any other sees 0 rows, i.e. "already used".
    const tokenHash = await hashResetToken(token);
    const [record] = await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.token, tokenHash))
      .returning({ userId: passwordResetTokens.userId, expires: passwordResetTokens.expires });

    if (!record) {
      return NextResponse.json(
        { error: "This reset link is invalid or has already been used." },
        { status: 400 }
      );
    }

    // Expired: the DELETE above already cleaned it up.
    if (record.expires.getTime() < Date.now()) {
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

    // Any other outstanding links for this account die with the reset — an
    // older email sitting in the inbox must not be able to set the password
    // again.
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, record.userId));

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
