import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { auth, hasRole } from "@/lib/auth";
import { internalKeyMatches, getAuthorizedSession } from "@/lib/api-auth";
import { authenticateVendorToken } from "@/lib/api-token-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import type { UserRole } from "@takemetothefair/constants";
import * as schema from "@/lib/db/schema";

/**
 * Route-handler wrappers that lift the boilerplate repeated across ~160 API
 * routes into one place. Each wrapper handles a different auth flavor but
 * shares the same db-open + error-funnel core ({@link dispatch}):
 *
 *   - {@link withAuth}        NextAuth session (optionally role-gated)
 *   - {@link withInternalKey} X-Internal-Key (cross-Worker / cron, no session)
 *   - {@link withApiToken}    vendor `mmatf_` Bearer token, scoped to a slug
 *
 * The inner handler receives a ready-made context and only writes the part
 * that is actually unique to the endpoint. See the bottom of this file for a
 * before/after.
 *
 * Behavior note: a present-but-under-privileged session returns **401** (not
 * 403) to preserve the exact response the hand-rolled `!session || role !== X`
 * checks emitted. Don't "fix" this to 403 without auditing clients/tests first.
 */

export type Db = DrizzleD1Database<typeof schema>;

/**
 * Next.js route-handler shape. The second arg carries `params` as a Promise in
 * Next 15. It is typed as required (not `ctx?:`) because Next's generated route
 * validators (`.next/types/**`) reject an optional second param — the `|
 * undefined` it introduces fails their `ParamCheck<RouteContext>` constraint.
 * Next always passes the context at runtime (with `params` resolving to `{}`
 * for static routes), but we still guard defensively below.
 */
type NextRouteHandler<P> = (request: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;

/**
 * Shared core: open D1, run the handler, funnel any throw to a 500 + logError.
 * Auth and context-shaping are the caller's job; this owns only the parts every
 * wrapper has in common.
 */
async function dispatch<C extends { request: NextRequest; db: Db }>(
  request: NextRequest,
  source: string | undefined,
  buildCtx: (db: Db) => C,
  handler: (ctx: C) => Promise<Response> | Response
): Promise<Response> {
  const db = getCloudflareDb();
  try {
    return await handler(buildCtx(db));
  } catch (error) {
    await logError(db, {
      message: "Unhandled error in API route",
      error,
      request,
      source: source ?? new URL(request.url).pathname,
      statusCode: 500,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** `ctx` is always supplied by Next at runtime; the guard is for direct (test) calls. */
async function resolveParams<P>(ctx: { params: Promise<P> } | undefined): Promise<P> {
  return (ctx ? await ctx.params : {}) as P;
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// ─── withAuth — NextAuth session ──────────────────────────────────────────────

export interface AuthContext<P> {
  request: NextRequest;
  /** Open D1 handle — already constructed; no need to call getCloudflareDb(). */
  db: Db;
  /** The authenticated session. Non-null because every wrapped route requires auth. */
  session: Session;
  /** Resolved dynamic route params (already awaited). `{}` for static routes. */
  params: P;
}

export interface WithAuthOptions {
  /**
   * Require this specific role (checked via {@link hasRole}, i.e. the `roles[]`
   * array, honoring dual-role users). Omit to require only that the caller is
   * signed in.
   */
  role?: UserRole;
  /** `source` tag for logError on throw. Defaults to the request pathname. */
  source?: string;
}

export type AuthedHandler<P> = (ctx: AuthContext<P>) => Promise<Response> | Response;

export function withAuth<P = Record<string, never>>(handler: AuthedHandler<P>): NextRouteHandler<P>;
export function withAuth<P = Record<string, never>>(
  options: WithAuthOptions,
  handler: AuthedHandler<P>
): NextRouteHandler<P>;
export function withAuth<P = Record<string, never>>(
  optionsOrHandler: WithAuthOptions | AuthedHandler<P>,
  maybeHandler?: AuthedHandler<P>
): NextRouteHandler<P> {
  const options: WithAuthOptions = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler)!;

  return async (request, ctx) => {
    const session = await auth();
    if (!session || (options.role && !hasRole(session, options.role))) {
      return unauthorized();
    }
    const params = await resolveParams(ctx);
    return dispatch(request, options.source, (db) => ({ request, db, session, params }), handler);
  };
}

// ─── withInternalKey — X-Internal-Key (cross-Worker / cron) ───────────────────

export interface InternalContext<P> {
  request: NextRequest;
  db: Db;
  params: P;
}

export type InternalHandler<P> = (ctx: InternalContext<P>) => Promise<Response> | Response;

export interface WithInternalKeyOptions {
  /** `source` tag for logError on throw. Defaults to the request pathname. */
  source?: string;
}

/**
 * Gate on a constant-time `X-Internal-Key` match — the main-app side of the
 * cross-Worker contract (MCP server + cron sweeps). No user session. Use this
 * instead of inlining `key === env.INTERNAL_API_KEY`, which is timing-unsafe
 * (the WS3 auth-centralization sweep tracks migrating those ~19 routes).
 */
export function withInternalKey<P = Record<string, never>>(
  handler: InternalHandler<P>
): NextRouteHandler<P>;
export function withInternalKey<P = Record<string, never>>(
  options: WithInternalKeyOptions,
  handler: InternalHandler<P>
): NextRouteHandler<P>;
export function withInternalKey<P = Record<string, never>>(
  optionsOrHandler: WithInternalKeyOptions | InternalHandler<P>,
  maybeHandler?: InternalHandler<P>
): NextRouteHandler<P> {
  const options: WithInternalKeyOptions =
    typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler)!;

  return async (request, ctx) => {
    if (!(await internalKeyMatches(request))) {
      return unauthorized();
    }
    const params = await resolveParams(ctx);
    return dispatch(request, options.source, (db) => ({ request, db, params }), handler);
  };
}

// ─── withApiToken — vendor `mmatf_` Bearer token, scoped to a slug param ───────

export interface ApiTokenContext<P> {
  request: NextRequest;
  db: Db;
  params: P;
  /** The vendor id the presented token is authorized for (matches the slug). */
  vendorId: string;
}

export type ApiTokenHandler<P> = (ctx: ApiTokenContext<P>) => Promise<Response> | Response;

export interface WithApiTokenOptions<P> {
  /** Param key holding the vendor slug the token is checked against. Default `"slug"`. */
  slugParam?: keyof P & string;
  /** `source` tag for logError on throw. Defaults to the request pathname. */
  source?: string;
}

/**
 * Gate on a vendor `mmatf_` Bearer token whose owner matches the vendor named
 * by `params[slugParam]` (default `slug`). On success the handler gets the
 * resolved `vendorId`. Failure returns 401 with the helper's specific error
 * message — same contract as the hand-rolled route.
 */
export function withApiToken<P extends Record<string, string> = { slug: string }>(
  options: WithApiTokenOptions<P>,
  handler: ApiTokenHandler<P>
): NextRouteHandler<P> {
  const slugParam = (options.slugParam ?? "slug") as keyof P & string;

  return async (request, ctx) => {
    const params = await resolveParams<P>(ctx);
    const result = await authenticateVendorToken(request, params[slugParam]);
    if (!result.authorized) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }
    const { vendorId } = result;
    return dispatch(request, options.source, (db) => ({ request, db, params, vendorId }), handler);
  };
}

// ─── withAuthorized — admin session OR X-Internal-Key OR read-only Bearer ──────

export interface AuthorizedContext<P> {
  request: NextRequest;
  db: Db;
  params: P;
  /**
   * Actor id for audit writes (`admin_actions.actorUserId`):
   *   - the user id for an ADMIN session
   *   - `null` for X-Internal-Key (system-driven) or read-only Bearer
   * Audit-writing handlers typically do `userId ?? "internal"`.
   */
  userId: string | null;
}

export type AuthorizedHandler<P> = (ctx: AuthorizedContext<P>) => Promise<Response> | Response;

export interface WithAuthorizedOptions {
  /** `source` tag for logError on throw. Defaults to the request pathname. */
  source?: string;
}

/**
 * Gate on {@link getAuthorizedSession} — authorized if the caller is an ADMIN
 * session OR presents a valid `X-Internal-Key` OR a read-only Bearer on a safe
 * method. This is the combined gate the MCP server + cron sweeps rely on; it's
 * the wrapper form of the `requireAdminAuth` / `getAuthorizedSession` family
 * (~39 routes). The handler gets `userId` for audit attribution.
 *
 * Failure returns the standard `{ error: "Unauthorized" }` 401 (matching
 * `requireAdminAuth`). Some hand-rolled routes returned a different 401 body
 * (e.g. `{ success: false, error: "unauthorized" }`); converting them
 * normalizes to this shape — these are admin/internal surfaces whose callers
 * key off the status code, not the body.
 */
export function withAuthorized<P = Record<string, never>>(
  handler: AuthorizedHandler<P>
): NextRouteHandler<P>;
export function withAuthorized<P = Record<string, never>>(
  options: WithAuthorizedOptions,
  handler: AuthorizedHandler<P>
): NextRouteHandler<P>;
export function withAuthorized<P = Record<string, never>>(
  optionsOrHandler: WithAuthorizedOptions | AuthorizedHandler<P>,
  maybeHandler?: AuthorizedHandler<P>
): NextRouteHandler<P> {
  const options: WithAuthorizedOptions =
    typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler)!;

  return async (request, ctx) => {
    const authz = await getAuthorizedSession(request);
    if (!authz.authorized) {
      return unauthorized();
    }
    const userId = authz.userId ?? null;
    const params = await resolveParams<P>(ctx);
    return dispatch(request, options.source, (db) => ({ request, db, params, userId }), handler);
  };
}

/*
 * ── Before ──────────────────────────────────────────────────────────────────
 * export async function GET(request: NextRequest) {
 *   const session = await auth();
 *   if (!session || session.user.role !== "ADMIN") {
 *     return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *   }
 *   try {
 *     const db = getCloudflareDb();
 *     const rows = await db.select()...;
 *     return NextResponse.json(rows);
 *   } catch (error) {
 *     console.error("...", error);
 *     return NextResponse.json({ error: "..." }, { status: 500 });
 *   }
 * }
 *
 * ── After ───────────────────────────────────────────────────────────────────
 * export const GET = withAuth({ role: "ADMIN" }, async ({ db }) => {
 *   const rows = await db.select()...;
 *   return NextResponse.json(rows);
 * });
 *
 * Dynamic routes get typed params for free:
 *   export const PATCH = withAuth<{ id: string }>(
 *     { role: "ADMIN" },
 *     async ({ db, params }) => { const { id } = params; ... }
 *   );
 *
 * Cross-Worker / vendor-token / admin-or-internal routes use the siblings:
 *   export const POST = withInternalKey(async ({ db }) => { ... });
 *   export const GET  = withApiToken<{ slug: string }>(
 *     {}, async ({ db, vendorId }) => { ... }
 *   );
 *   export const POST = withAuthorized(async ({ db, userId }) => {
 *     await db.insert(adminActions).values({ actorUserId: userId ?? "internal", ... });
 *   });
 */
