/**
 * OPE-1397 — per-page guards for the portal segments, siblings of
 * `requireAdmin()` (`src/lib/require-admin.ts`, OPE-1365).
 *
 * Why the page has to check even though `src/app/vendor/layout.tsx` and
 * `src/app/promoter/layout.tsx` already do: an `RSC: 1` request whose
 * client-supplied `Next-Router-State-Tree` says the layout is already mounted
 * renders ONLY the page segment, so the layout's redirect never runs (the
 * OPE-1365 reproduction). Before this, `/promoter/events`, `/vendor/applications`
 * and `/vendor/calendar` checked for a session but not the role.
 *
 *   - `requireRole("VENDOR" | "PROMOTER")` mirrors the portal layouts exactly:
 *     signed out → `/login?callbackUrl=<portal home>`; signed in with a role
 *     other than the portal's role or ADMIN → `/dashboard`.
 *   - `requireSession()` is for `/dashboard/**` (any signed-in user):
 *     signed out → `/login?callbackUrl=<page>`.
 *
 * Both must be the FIRST statement of the page's default export. CI guard:
 * `src/lib/__tests__/portal-pages-require-role-ope1397.test.ts`.
 */
import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";

export type PortalRole = "VENDOR" | "PROMOTER";

/** Same callbackUrls the portal layouts use today. */
export const PORTAL_LOGIN_REDIRECT: Record<PortalRole, string> = {
  VENDOR: "/login?callbackUrl=/vendor/profile",
  PROMOTER: "/login?callbackUrl=/promoter/events",
};

/** Where a signed-in user with the wrong role is sent (matches the layouts). */
export const WRONG_ROLE_REDIRECT = "/dashboard";

/**
 * Returns the session of a user whose role is `role` or ADMIN. Never returns
 * for anyone else — `redirect()` throws. `callbackUrl` (a same-site path)
 * overrides the portal-home login callback for a signed-out visitor.
 */
export async function requireRole(role: PortalRole, callbackUrl?: string): Promise<Session> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(callbackUrl ? `/login?callbackUrl=${callbackUrl}` : PORTAL_LOGIN_REDIRECT[role]);
  }
  if (session.user.role !== role && session.user.role !== "ADMIN") {
    redirect(WRONG_ROLE_REDIRECT);
  }
  return session;
}

/**
 * Returns the session of any signed-in user, else redirects to /login with
 * `callbackUrl` (a same-site path, e.g. "/dashboard/claims").
 */
export async function requireSession(callbackUrl = "/dashboard"): Promise<Session> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${callbackUrl}`);
  }
  return session;
}
