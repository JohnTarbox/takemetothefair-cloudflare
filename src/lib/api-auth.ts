import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareEnv } from "@/lib/cloudflare";

/**
 * Sentinel actor id for the Claude read-only Bearer token. Use as
 * `actorUserId` in admin_actions writes when the request authorized via
 * the read-only Bearer (today this can never happen because Bearer requests
 * can't mutate, but the sentinel is reserved for any future read-audit hook).
 */
export const CLAUDE_READONLY_IDENTITY = "claude-readonly";

/**
 * HTTP methods the read-only Bearer token is allowed to make. HEAD is the
 * read-only twin of GET; OPTIONS is the CORS preflight courtesy. Everything
 * else (POST/PUT/PATCH/DELETE) is rejected at the middleware layer.
 *
 * INVARIANT: GET handlers under /admin/* and /api/admin/* must remain
 * side-effect-free (no db.insert/update/delete). The Bearer-token read-only
 * guarantee depends on this — the method gate is the safety boundary, not a
 * per-path allowlist.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Returns true if the request's Authorization header is `Bearer <token>` AND
 * `<token>` matches the CLAUDE_READONLY_TOKEN env var. Returns false on any
 * mismatch (including missing env, malformed header, wrong scheme).
 */
export function bearerTokenMatches(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return false;
  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  const expected = env.CLAUDE_READONLY_TOKEN;
  if (!expected) return false;
  return presented === expected;
}

/**
 * Authenticate via admin session OR X-Internal-Key header OR Claude
 * read-only Bearer (limited to safe HTTP methods).
 * Returns true if authorized, false otherwise.
 */
export async function isAuthorized(request: Request): Promise<boolean> {
  // Check session auth first
  const session = await auth();
  if (session?.user?.role === "ADMIN") return true;

  // X-Internal-Key (for MCP server calls + cron sweeps)
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey) {
    const env = getCloudflareEnv() as unknown as Record<string, string>;
    const expectedKey = env.INTERNAL_API_KEY;
    if (expectedKey && internalKey === expectedKey) return true;
  }

  // Claude read-only Bearer (safe methods only). Mutations with this token
  // are blocked at the edge by src/middleware.ts before reaching the route,
  // but we double-check here so a route can't be tricked into authorizing a
  // POST if the middleware matcher ever drifts out of sync.
  if (isSafeMethod(request.method) && bearerTokenMatches(request)) return true;

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

  if (isSafeMethod(request.method) && bearerTokenMatches(request)) {
    return { authorized: true };
  }

  return { authorized: false };
}

/**
 * Return the actor identity for an authorized request, suitable for use as
 * `actorUserId` in admin_actions writes. Returns:
 *   - the user id string for an ADMIN session
 *   - the CLAUDE_READONLY_IDENTITY sentinel for a read-only Bearer match
 *   - null for X-Internal-Key (system-driven) or no auth
 *
 * Callers should resolve auth FIRST (via isAuthorized) and only use this for
 * the audit-log identity field.
 */
export async function getRequestIdentity(request: Request): Promise<string | null> {
  const session = await auth();
  if (session?.user?.role === "ADMIN") return session.user.id;
  if (isSafeMethod(request.method) && bearerTokenMatches(request)) {
    return CLAUDE_READONLY_IDENTITY;
  }
  return null;
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
