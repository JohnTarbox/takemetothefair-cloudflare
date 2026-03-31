import { eq } from "drizzle-orm";
import { apiTokens, users, vendors, promoters } from "./schema.js";
import type { Db } from "./db.js";

export interface AuthContext {
  userId: string;
  role: "ADMIN" | "PROMOTER" | "VENDOR" | "USER";
  vendorId?: string;
  promoterId?: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hash a raw token string */
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

/**
 * Validate a Bearer token and resolve the user's role + associated IDs.
 * Returns null if the token is invalid or not found.
 */
export async function authenticateToken(
  db: Db,
  authHeader: string | null,
): Promise<AuthContext | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) return null;

  const tokenHash = await hashToken(rawToken);

  // Look up the token
  const tokenRows = await db
    .select({
      tokenId: apiTokens.id,
      userId: apiTokens.userId,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);

  if (tokenRows.length === 0) return null;

  const { tokenId, userId } = tokenRows[0];

  // Get user with role
  const userRows = await db
    .select({
      id: users.id,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (userRows.length === 0) return null;

  const user = userRows[0];

  // Update last_used_at (fire-and-forget, don't await)
  db.update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, tokenId))
    .then(() => {})
    .catch(() => {});

  const ctx: AuthContext = {
    userId: user.id,
    role: user.role as AuthContext["role"],
  };

  // Resolve vendor/promoter IDs if applicable
  if (user.role === "VENDOR" || user.role === "ADMIN") {
    const vendorRows = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.userId, user.id))
      .limit(1);
    if (vendorRows.length > 0) ctx.vendorId = vendorRows[0].id;
  }

  if (user.role === "PROMOTER" || user.role === "ADMIN") {
    const promoterRows = await db
      .select({ id: promoters.id })
      .from(promoters)
      .where(eq(promoters.userId, user.id))
      .limit(1);
    if (promoterRows.length > 0) ctx.promoterId = promoterRows[0].id;
  }

  return ctx;
}
