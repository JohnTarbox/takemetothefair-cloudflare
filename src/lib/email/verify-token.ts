import { and, eq } from "drizzle-orm";
import { users, verificationTokens } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

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
): Promise<{ ok: true; email: string } | { ok: false; reason: "not_found" | "expired" }> {
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

  return { ok: true, email: record.identifier };
}
