import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { timingSafeEqualString } from "@takemetothefair/utils";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { users } from "@/lib/db/schema";

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
export async function bearerTokenMatches(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return false;
  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  const expected = env.CLAUDE_READONLY_TOKEN;
  if (!expected) return false;
  return timingSafeEqualString(presented, expected);
}

/**
 * Constant-time check of the inbound `X-Internal-Key` header against the
 * `INTERNAL_API_KEY` secret — the main-app side of the cross-Worker contract
 * (MCP server + cron sweeps authenticate this way).
 *
 * This is the single source of truth for that check. ~16 route handlers still
 * inline their own `internalKey === env.INTERNAL_API_KEY` (a timing-unsafe
 * `===`, copy-pasted); migrating them to this helper is tracked as part of the
 * auth-centralization sweep (WS3). `Headers.get` is case-insensitive, so this
 * matches both `X-Internal-Key` and `x-internal-key` spellings.
 */
export async function internalKeyMatches(request: Request): Promise<boolean> {
  const internalKey = request.headers.get("x-internal-key");
  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  return timingSafeEqualString(internalKey, env.INTERNAL_API_KEY);
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
  if (await internalKeyMatches(request)) return true;

  // Claude read-only Bearer (safe methods only). Mutations with this token
  // are blocked at the edge by src/middleware.ts before reaching the route,
  // but we double-check here so a route can't be tricked into authorizing a
  // POST if the middleware matcher ever drifts out of sync.
  if (isSafeMethod(request.method) && (await bearerTokenMatches(request))) return true;

  return false;
}

/**
 * Check if request has admin auth, returning the session if available.
 * Useful when you need the session user info (e.g., authorId).
 *
 * `allowReadonlyBearer` (default true) controls whether the Claude read-only
 * Bearer is accepted on safe methods. Pass `false` for endpoints that have
 * read-shaped methods but real side effects (e.g. a GET that triggers an
 * outbound fetch), so only an admin session or the internal key authorize.
 */
export async function getAuthorizedSession(
  request: Request,
  opts: { allowReadonlyBearer?: boolean } = {}
): Promise<{
  authorized: boolean;
  userId?: string;
}> {
  const { allowReadonlyBearer = true } = opts;
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { authorized: true, userId: session.user.id };
  }

  if (await internalKeyMatches(request)) return { authorized: true };

  if (allowReadonlyBearer && isSafeMethod(request.method) && (await bearerTokenMatches(request))) {
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
  if (isSafeMethod(request.method) && (await bearerTokenMatches(request))) {
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

/**
 * Gate result for `requireVerifiedSession`. On `ok: false`, the caller
 * should `return result.response` directly. On `ok: true`, the resolved
 * `userId` + `email` are safe to use.
 */
export type VerifiedSessionResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; response: NextResponse };

/**
 * Single-call session + email-verification gate for vendor (and other
 * end-user) API routes. Two-step check:
 *
 *   1. Logged in?  No → 401 Unauthorized.
 *   2. `users.email_verified` is non-null?  No → 403 with a structured
 *      `{error: "email_unverified", message, verifyUrl}` shape so the
 *      frontend can render a "Verify your email to continue" CTA.
 *
 * OAuth signups (Google/Facebook) get `emailVerified` auto-set at
 * user-create time (lib/auth.ts) — the OAuth provider's email vouch
 * counts as verification. So this gate only ever fires for the
 * password-signup path who hasn't clicked the verification link yet.
 *
 * Pattern:
 *
 *     export async function PUT(request: NextRequest) {
 *       const gate = await requireVerifiedSession();
 *       if (!gate.ok) return gate.response;
 *       const { userId, email } = gate;
 *       // ...handler body
 *     }
 *
 * Added 2026-05-24 (PR following #226) as the first three vendor gates
 * on emailVerified: profile EDIT, event-application submission, and
 * contact-form forwarding. Before that, verification was advisory —
 * unverified users could do everything a verified user could.
 */
export async function requireVerifiedSession(): Promise<VerifiedSessionResult> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  try {
    const db = getCloudflareDb();
    const [user] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (!user?.emailVerified) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "email_unverified",
            message:
              "Please verify your email address before continuing. Check your inbox for the verification link, or request a new one from your dashboard.",
            verifyUrl: "/api/auth/send-verification",
          },
          { status: 403 }
        ),
      };
    }

    return { ok: true, userId: session.user.id, email: session.user.email };
  } catch {
    // DB error — fall back to the same 403 shape so we never silently
    // permit a write on a verification-gated route when the gate itself
    // couldn't run. Better to nag a verified user than to skip the
    // check.
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "verification_check_failed",
          message: "Could not verify your account status. Please try again.",
        },
        { status: 503 }
      ),
    };
  }
}

/**
 * Anonymous-caller variant for surfaces that gate on a target user's
 * (not the caller's) verification status — e.g., the vendor contact
 * form, where we don't forward messages to a vendor whose account
 * holder hasn't proven email control.
 *
 * Returns `true` only when the user row exists AND `emailVerified` is
 * non-null. A null `userId` (placeholder vendor with no real owner)
 * returns `false`.
 */
export async function targetUserIsVerified(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  try {
    const db = getCloudflareDb();
    const [user] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return !!user?.emailVerified;
  } catch {
    // Fail closed — if we can't check, don't forward.
    return false;
  }
}
