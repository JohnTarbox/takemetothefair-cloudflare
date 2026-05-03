import { NextResponse } from "next/server";
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

/**
 * Single-call admin gate for API route handlers.
 *
 * Returns a `NextResponse` (401) on failure that the handler should `return`
 * directly, or `null` on success. Pattern:
 *
 *     export async function POST(request: NextRequest) {
 *       const fail = await requireAdminAuth(request);
 *       if (fail) return fail;
 *       // ...handler body
 *     }
 *
 * This is the **forward-going** convention for admin routes. Many existing
 * routes still inline the older `const session = await auth(); if (!session
 * || session.user.role !== "ADMIN") ...` block — they work fine but are
 * NextAuth-only (won't accept the X-Internal-Key from the MCP server / cron
 * handler). Convert as you touch them; not worth a 37-file mass migration
 * since today's MCP-callable surfaces (sweeps, recommendations scan) already
 * use isAuthorized/getAuthorizedSession.
 *
 * If a handler also needs `userId` for audit logging, call `auth()` directly
 * after the gate or use `getAuthorizedSession()` instead.
 */
export async function requireAdminAuth(request: Request): Promise<NextResponse | null> {
  if (await isAuthorized(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
