/**
 * OPE-1366 — keep a JWT session's role current, and end it when the account's
 * session generation moves on.
 *
 * The web app uses Auth.js's JWT strategy (src/lib/auth.ts), so a session is a
 * signed cookie that nothing server-side can revoke. Before this, `role` was
 * written into the token once at sign-in and never re-read, so a demoted admin
 * kept admin until the 30-day JWT expired, and a password reset ended nobody's
 * session.
 *
 * Now the token carries `sessionVersion` (users.session_version at sign-in) and
 * `checkedAt`. On a request whose token was last checked more than
 * SESSION_RECHECK_INTERVAL_MS ago, the jwt callback re-reads the user:
 *   - user row gone                    -> null (Auth.js clears the cookie)
 *   - session_version != the token's   -> null (password reset / role change)
 *   - otherwise                         -> role + roles refreshed, checkedAt = now
 *
 * Returning null from the jwt callback is the Auth.js v5 (core 0.41) sign-out
 * signal: `lib/actions/session.js` pushes `sessionStore.clean()` and returns a
 * null session, so `auth()` reads as signed-out.
 *
 * D1 FAILURE IS FAIL-OPEN. If the re-read throws, the token is returned
 * unchanged (and `checkedAt` is NOT advanced, so the very next request retries).
 * A D1 outage already breaks almost every page; turning it into "every
 * signed-in user is signed out" would add a mass logout on top and buy nothing,
 * since the revocation it would enforce is re-applied on the first request
 * after D1 recovers. The failure is logged.
 *
 * A token minted before this shipped has no `sessionVersion`; it is treated as
 * 0 — the value every row was created with by drizzle/0371 — so the deploy ends
 * no session, while a reset after the deploy still ends the old ones.
 */

export type SessionRole = "ADMIN" | "PROMOTER" | "VENDOR" | "USER";

/** Re-read the user at most this often per token (one PK lookup + one roles read). */
export const SESSION_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface RefreshableToken {
  id?: string;
  role?: SessionRole;
  roles?: SessionRole[];
  sessionVersion?: number;
  checkedAt?: number;
}

export interface CurrentUserState {
  role: SessionRole;
  roles: SessionRole[];
  sessionVersion: number;
}

export interface SessionRefreshDeps {
  now: () => number;
  /** Current role/roles/version for the user, or null if the row is gone. May throw. */
  loadUser: (userId: string) => Promise<CurrentUserState | null>;
  logFailure: (error: unknown, userId: string) => void | Promise<void>;
}

export async function refreshSessionToken<T extends RefreshableToken>(
  token: T,
  deps: SessionRefreshDeps
): Promise<T | null> {
  if (!token.id) return token;
  const now = deps.now();
  if (typeof token.checkedAt === "number" && now - token.checkedAt < SESSION_RECHECK_INTERVAL_MS) {
    return token;
  }

  let current: CurrentUserState | null;
  try {
    current = await deps.loadUser(token.id);
  } catch (error) {
    try {
      await deps.logFailure(error, token.id);
    } catch {
      // logging must never turn a fail-open into a failure
    }
    return token;
  }

  if (!current) return null;
  if (current.sessionVersion !== (token.sessionVersion ?? 0)) return null;

  token.role = current.role;
  token.roles = current.roles.includes(current.role)
    ? current.roles
    : [...current.roles, current.role];
  token.checkedAt = now;
  return token;
}
