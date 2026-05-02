import { getCloudflareDb } from "@/lib/cloudflare";
import { apiTokens, vendors } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

/**
 * Authenticate a request via Bearer token and verify the token owner
 * matches the vendor identified by slug.
 *
 * Returns the vendorId if authorized, null otherwise.
 */
export async function authenticateVendorToken(
  request: Request,
  vendorSlug: string
): Promise<{ authorized: true; vendorId: string } | { authorized: false; error: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { authorized: false, error: "Missing or invalid Authorization header" };
  }

  const rawToken = authHeader.slice(7);
  if (!rawToken.startsWith("mmatf_")) {
    return { authorized: false, error: "Invalid token format" };
  }

  const db = getCloudflareDb();
  const tokenHash = await hashToken(rawToken);

  // Look up the token
  const tokenResults = await db
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);

  if (tokenResults.length === 0) {
    return { authorized: false, error: "Invalid token" };
  }

  const { userId } = tokenResults[0];

  // Update last used timestamp (fire and forget). Don't route through
  // logError — this is a hot-path background write; if D1 is degraded
  // we don't want to compound the problem by logging to D1 too. The
  // console log surfaces in `wrangler tail` for forensic diagnosis.
  db.update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.tokenHash, tokenHash))
    .catch((err) => {
      console.error("[API Token] Failed to update lastUsedAt:", err);
    });

  // Verify the vendor belongs to this user
  const vendorResults = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.slug, vendorSlug), eq(vendors.userId, userId)))
    .limit(1);

  if (vendorResults.length === 0) {
    return { authorized: false, error: "Token does not match this vendor" };
  }

  return { authorized: true, vendorId: vendorResults[0].id };
}
