// Vendor self-serve claim verification tokens. The raw token only ever
// exists in the verification email URL; we store its SHA-256 hex digest
// so a database compromise can't be used to impersonate a vendor.

import { eq, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { vendorClaimTokens, vendors } from "@/lib/db/schema";

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

function generateRawToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

type Db = DrizzleD1Database<Record<string, unknown>>;

export async function createClaimToken(
  db: Db,
  args: { vendorId: string; userId: string }
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const tokenHash = await sha256Hex(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000);
  await db.insert(vendorClaimTokens).values({
    vendorId: args.vendorId,
    userId: args.userId,
    tokenHash,
    createdAt: now,
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export type ClaimTokenValidation =
  | { ok: true; vendorId: string; userId: string }
  | { ok: false; reason: "not_found" | "expired" };

/**
 * Validate a raw token and consume it (single-use). Caller is responsible
 * for the actual claim flip + audit log + email AFTER this returns ok.
 */
export async function consumeClaimToken(db: Db, rawToken: string): Promise<ClaimTokenValidation> {
  const tokenHash = await sha256Hex(rawToken);
  const [record] = await db
    .select()
    .from(vendorClaimTokens)
    .where(eq(vendorClaimTokens.tokenHash, tokenHash))
    .limit(1);
  if (!record) return { ok: false, reason: "not_found" };
  // Opportunistic sweep of expired rows for THIS token's hash window.
  if (record.expiresAt.getTime() < Date.now()) {
    await db.delete(vendorClaimTokens).where(eq(vendorClaimTokens.tokenHash, tokenHash));
    return { ok: false, reason: "expired" };
  }
  // Verify the vendor still exists and the user still owns it (defence
  // against userId reassignment between initiate and confirm).
  const [vendor] = await db
    .select({ id: vendors.id, userId: vendors.userId, claimed: vendors.claimed })
    .from(vendors)
    .where(eq(vendors.id, record.vendorId))
    .limit(1);
  if (!vendor || vendor.userId !== record.userId) {
    await db.delete(vendorClaimTokens).where(eq(vendorClaimTokens.tokenHash, tokenHash));
    return { ok: false, reason: "not_found" };
  }
  // Single-use: delete on consume.
  await db.delete(vendorClaimTokens).where(eq(vendorClaimTokens.tokenHash, tokenHash));
  return { ok: true, vendorId: record.vendorId, userId: record.userId };
}

/**
 * Periodic sweep — not currently called from a cron (project has no cron;
 * see feedback_no_cron_triggers.md). Useful as a one-shot endpoint or as
 * a piggyback on other vendor mutations later.
 */
export async function sweepExpiredClaimTokens(db: Db): Promise<number> {
  const result = await db
    .delete(vendorClaimTokens)
    .where(lt(vendorClaimTokens.expiresAt, new Date()))
    .returning({ id: vendorClaimTokens.id });
  return result.length;
}

// Re-export for type-only consumers.
export type { Db as ClaimTokenDb };
