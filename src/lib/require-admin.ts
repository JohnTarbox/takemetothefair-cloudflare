/**
 * OPE-1365 — the per-page admin guard for `src/app/admin/**\/page.tsx`.
 *
 * Why every page needs this even though `src/app/admin/layout.tsx` already
 * checks the role: the App Router decides which segments to render from the
 * client-supplied `Next-Router-State-Tree` header. A request with `RSC: 1` and
 * a state tree that says "the /admin layout is already mounted" renders ONLY
 * the page segment — the layout (and its redirect) never runs. Reproduced
 * locally against `next dev` on 2026-10-15: signed out, `/admin/claims` with
 * such a tree returned 200 with the claimant's email in the RSC payload while
 * the plain GET 307'd to /login. A layout is navigation chrome, not an
 * authorization boundary; the page has to check for itself.
 *
 * Mirrors the layout's rule exactly so the two never disagree:
 *   1. A valid read-only `Authorization: Bearer <CLAUDE_READONLY_TOKEN>`
 *      passes (page renders are GETs; the edge middleware already 403s any
 *      non-safe method carrying that Bearer). Pages that historically refused
 *      the token pass `{ allowReadonlyBearer: false }` to keep doing so.
 *   2. Otherwise the NextAuth session must have `role === "ADMIN"`, or the
 *      request is redirected to /login.
 *
 * CI guard: `src/lib/__tests__/
 * admin-pages-require-admin.test.ts` fails if any server-component admin page
 * stops calling this.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { bearerTokenMatches } from "@/lib/api-auth";

export const ADMIN_LOGIN_REDIRECT = "/login?callbackUrl=/admin";

export interface RequireAdminOptions {
  /** Accept the read-only Claude Bearer token (default true, same as the layout). */
  allowReadonlyBearer?: boolean;
}

/**
 * Returns the admin session, or `null` when the caller authenticated with the
 * read-only Bearer token (no session exists then). Never returns for anyone
 * else — `redirect()` throws.
 */
export async function requireAdmin(options: RequireAdminOptions = {}): Promise<Session | null> {
  const { allowReadonlyBearer = true } = options;

  if (allowReadonlyBearer) {
    const authHeader = (await headers()).get("authorization");
    if (authHeader) {
      // bearerTokenMatches expects a Request; give it one carrying just the header.
      const synthetic = new Request("https://internal/", {
        headers: { authorization: authHeader },
      });
      if (await bearerTokenMatches(synthetic)) return null;
    }
  }

  const session = await auth();
  if (!session || session.user?.role !== "ADMIN") {
    redirect(ADMIN_LOGIN_REDIRECT);
  }
  return session;
}
