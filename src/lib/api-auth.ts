import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { timingSafeEqualString } from "@takemetothefair/utils";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { users } from "@/lib/db/schema";
import { getBurstLimiter } from "@/lib/rate-limit";
import { isDeployedEnvironment } from "@/lib/runtime-env";

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
  const expected = env.INTERNAL_API_KEY;
  // OPE-902 — `await`. Without it `ok` is a PROMISE, which is always truthy,
  // so `!ok` was always false and the refusal log below never ran once. The
  // RETURN was still correct, because callers await the promise this handed
  // back — which is why a whole security log could be empty and nothing else
  // looked wrong.
  const ok = await timingSafeEqualString(internalKey, expected);
  if (!ok && internalKey) {
    // OPE-258 — a caller that PRESENTED a key and was refused. Record why.
    //
    // This exists because OPE-258 burned three investigation cycles unable to
    // answer one question: does the key arrive intact? Two prior probes
    // fingerprinted the SENDER's env (identical across entrypoints) and still
    // could not distinguish "header stripped in transit" from "header arrives
    // but differs" from "receiver's own secret is missing". Those are three
    // different bugs with three different fixes, and a bare 401 tells you
    // none of them.
    //
    // Gated on `internalKey` being present so ordinary unauthenticated traffic
    // and internet background noise never reach this path — only a caller that
    // genuinely tried to authenticate.
    scheduleRefusalRecord(request, internalKey, expected);
  }
  return ok;
}

/**
 * Per-route budget for refusal records, spent against the Workers Rate
 * Limiting binding (`limit = 5`, `period = 60` — see `wrangler.toml`).
 *
 * ## Why a budget exists at all
 *
 * `internalKeyMatches` runs BEFORE `checkRateLimit` on the public
 * suggest-event routes, and that ordering is deliberate: an internal caller
 * skips the rate limit, so the identity check has to come first. The
 * consequence nobody costed is that anyone who sends an `x-internal-key`
 * header — a header an attacker fully controls — reaches this diagnostic
 * ahead of every throttle in the system. One D1 write per request, unbounded.
 *
 * Verified rather than assumed, 2026-09-11:
 *   src/app/api/suggest-event/submit/route.ts:65   internalKeyMatches(request)
 *   src/app/api/suggest-event/submit/route.ts:69   checkRateLimit(...)
 *
 * ## Why the Workers binding and not the KV counter
 *
 * OPE-904 measured the KV quota losing increments under exactly the burst it
 * exists to stop — 81 requests against a 60/hour cap produced 27 recorded
 * increments and zero refusals. A cap that undercounts is a cap that
 * over-writes, which is the failure being fixed. The binding is enforced by
 * the runtime and does not lose.
 *
 * ## Why the key is the route
 *
 * The budget is per key, so keying on the route means a flood against
 * `/api/suggest-event/submit` cannot starve the diagnostic on a different
 * path. The obvious alternative — bucketing by whether the caller stamped
 * `x-mmatf-entrypoint` — was rejected: that header is attacker-supplied, and
 * a bucketing decision that trusts it is a security claim I cannot make.
 *
 * ## The missing-binding branch, and why it fails CLOSED
 *
 * OPE-931 removed two predicates that answered "am I in production?" with a
 * variable Workers never set, so both fail-closed branches failed OPEN. The
 * same shape is available here and is refused: on a deployed Worker, no
 * binding means NO record is written. Losing a diagnostic is the cheap
 * failure; resuming unbounded writes is the expensive one, and it is the
 * exact defect this function is being repaired for.
 *
 * Off a deployed Worker (unit tests, `next dev`) there is no binding and no
 * exposure, so the record is written — that is where the diagnostic is
 * actually read during development.
 */
async function refusalRecordBudgetAvailable(route: string): Promise<boolean> {
  const limiter = getBurstLimiter();
  if (!limiter) return !isDeployedEnvironment();
  try {
    return (await limiter.limit({ key: `internal-key-refusal:${route}` })).success;
  } catch {
    // A limiter that throws cannot authorize a write. Same reasoning as the
    // missing-binding branch above.
    return false;
  }
}

/**
 * Hand the refusal record to the runtime so it survives the response.
 *
 * The previous form was `void recordInternalKeyRefusal(...)` — not awaited and
 * not registered, so the Workers runtime was free to tear the promise down the
 * moment the response was sent. A diagnostic that may or may not be written is
 * worse than none, because its absence reads as "no refusal happened".
 *
 * Deliberately NOT awaited by the caller: `internalKeyMatches` is on the
 * authentication path and must not gain a D1 write's latency, nor fail because
 * its diagnostics did.
 */
function scheduleRefusalRecord(
  request: Request,
  presented: string,
  expected: string | undefined
): void {
  const work = recordInternalKeyRefusal(request, presented, expected).catch(() => {
    // recordInternalKeyRefusal swallows internally; this guards the outer
    // promise so an unexpected throw can never surface on the auth path.
  });
  try {
    getCloudflareContext().ctx.waitUntil(work);
  } catch {
    // Outside the Cloudflare runtime (unit tests, local dev) there is no ctx.
    // The promise still runs; there is nothing to register it with.
  }
}

/**
 * Log a NON-SECRET forensic record of a refused internal-key request.
 *
 * Never logs either key. A short SHA-256 prefix of the PRESENTED value answers
 * "what actually arrived?" — the question OPE-258 burned three investigation
 * cycles on — while being useless to an attacker who obtains the logs.
 *
 * ⚠️ Nothing derived from the REAL key is recorded any more. This previously
 * stored `expectedLen` and `expectedFp`: the live secret's length, and a
 * 32-bit fingerprint of it. Neither is needed. `ok === false` already proves
 * the two values differ, and `expectedPresent` already distinguishes "the
 * receiver has no secret" from "it has one that doesn't match" — which were
 * the two situations OPE-258 could not tell apart. What they added instead was
 * an OFFLINE oracle: with the length and a fingerprint in hand, a candidate
 * key can be tested without ever touching the server. A diagnostic about a
 * secret should not narrow the search space for that secret.
 *
 * Fully swallowed: an auth check must never fail, slow down, or throw because
 * its diagnostics did. Registered with `ctx.waitUntil` by the caller so it
 * still completes after the response.
 */
async function recordInternalKeyRefusal(
  request: Request,
  presented: string,
  expected: string | undefined
): Promise<void> {
  try {
    const url = new URL(request.url);
    // Spend the budget BEFORE doing any work. A refused budget must cost a
    // limiter call and nothing else — no digest, no D1 round trip.
    if (!(await refusalRecordBudgetAvailable(url.pathname))) return;

    // Only ever applied to the PRESENTED value now, which the caller has
    // already proven non-empty — so the old `if (!v) return null` guard is
    // gone rather than left sitting there looking like it still protects
    // something.
    const fp = async (v: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
      return Array.from(new Uint8Array(digest))
        .slice(0, 4)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    };
    const { logError } = await import("@/lib/logger");
    await logError(getCloudflareDb(), {
      level: "warn",
      source: "api-auth:internal-key-refused",
      message: "X-Internal-Key presented but did not match",
      statusCode: 401,
      route: url.pathname,
      context: {
        method: request.method,
        // Which caller — MCP stamps this per entrypoint (fetch/scheduled/
        // queue/workflow/do). Its absence is itself informative: it means the
        // caller predates the stamping or is not our MCP Worker.
        callerEntrypoint: request.headers.get("x-mmatf-entrypoint") ?? "(unstamped)",
        presentedLen: presented.length,
        presentedFp: await fp(presented),
        // Whether the RECEIVER holds a secret at all — the one fact about the
        // expected side worth recording. Its length and fingerprint are
        // deliberately absent; see the docblock.
        expectedPresent: !!expected,
        // Cloudflare stamps this on Worker-issued subrequests; its presence
        // distinguishes a cross-Worker call from an external client.
        cfWorker: request.headers.get("cf-worker"),
      },
    });
  } catch {
    // Diagnostics must never break authentication.
  }
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
  | {
      ok: false;
      response: NextResponse;
      /**
       * OPE-830 — who was refused, and why, so the caller can record the
       * rejection.
       *
       * The failure branch used to carry only the response, which meant a
       * refused write could not be attributed to anyone and therefore could
       * not be logged. Two live "my profile won't save" reports were
       * unanswerable for exactly that reason: the gate returns above the
       * route's first log call, so a rejected save left no trace, and
       * "no record of a save" was indistinguishable from "no save attempted".
       *
       * `userId` is undefined only when there was no session to identify.
       */
      userId?: string;
      reason: "unauthenticated" | "email_unverified" | "verification_check_failed";
    };

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
      userId: session?.user?.id,
      reason: "unauthenticated",
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
        userId: session.user.id,
        reason: "email_unverified",
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
      userId: session.user.id,
      reason: "verification_check_failed",
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
