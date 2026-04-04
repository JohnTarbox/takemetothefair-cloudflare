import { auth } from "@/lib/auth";
import { getCloudflareEnv } from "@/lib/cloudflare";

/**
 * Authenticate via admin session OR X-Internal-Key header.
 * Returns true if authorized, false otherwise.
 */
export async function isAuthorized(request: Request): Promise<boolean> {
  // Check session auth first
  const session = await auth();
  if (session?.user?.role === "ADMIN") return true;

  // Fall back to internal API key (for MCP server calls)
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey) {
    const env = getCloudflareEnv() as unknown as Record<string, string>;
    const expectedKey = env.INTERNAL_API_KEY;
    if (expectedKey && internalKey === expectedKey) return true;
  }

  return false;
}

/**
 * Check if request has admin auth, returning the session if available.
 * Useful when you need the session user info (e.g., authorId).
 */
export async function getAuthorizedSession(request: Request): Promise<{
  authorized: boolean;
  userId?: string;
}> {
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { authorized: true, userId: session.user.id };
  }

  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey) {
    const env = getCloudflareEnv() as unknown as Record<string, string>;
    const expectedKey = env.INTERNAL_API_KEY;
    if (expectedKey && internalKey === expectedKey) return { authorized: true };
  }

  return { authorized: false };
}
