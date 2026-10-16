import { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import type {
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { getDb } from "../db.js";
import { lookupUserById, resolveUserProps, type UserProps } from "./utils.js";

/**
 * OPE-1366 — re-resolve a grant's props from D1 on every refresh.
 *
 * `login-handler.ts` freezes role / vendorId / promoterId into the grant props
 * at login. Without this callback a demoted admin kept admin tools for the
 * whole refresh chain (30-day refresh TTL), and a password reset revoked
 * nothing.
 *
 * On a refresh (or token exchange):
 *   - user row gone                         -> invalid_grant (the library revokes the grant)
 *   - users.session_version != props value  -> invalid_grant (password reset / role change)
 *   - otherwise                              -> fresh props from `resolveUserProps`, the
 *                                              same resolver login uses, stored on the grant
 *                                              and the new access token.
 *
 * The authorization_code exchange is left alone: its props were resolved by
 * the login a moment earlier.
 *
 * Staleness bound: the main app cannot revoke grants itself (they live in the
 * MCP Worker's OAUTH_KV, keyed by the provider's own scheme), so an access
 * token already issued stays valid until it expires — the provider default
 * `accessTokenTTL` of 3600 s, which provider-options.ts does not override. A
 * demotion or reset therefore reaches MCP within at most 1 hour.
 *
 * D1 failure is NOT invalid_grant: that would permanently revoke every grant
 * refreshed during an outage. It answers temporarily_unavailable (503 +
 * Retry-After), so the refresh is refused for now — nothing is issued on props
 * we could not check — and the grant survives for the retry.
 */
export async function refreshGrantProps<E extends { DB: D1Database }>(
  options: TokenExchangeCallbackOptions<E>
): Promise<TokenExchangeCallbackResult | void> {
  if (
    options.grantType !== GrantType.REFRESH_TOKEN &&
    options.grantType !== GrantType.TOKEN_EXCHANGE
  ) {
    return;
  }

  const stored = (options.props ?? {}) as Partial<UserProps>;
  let fresh: UserProps;
  try {
    const db = getDb(options.env.DB);
    const user = await lookupUserById(db, options.userId);
    if (!user) {
      throw new OAuthError("invalid_grant", {
        description: "This account no longer exists. Sign in again.",
        internal: { category: "token-exchange-callback", reason: "user_missing" },
      });
    }
    if (user.sessionVersion !== (stored.sessionVersion ?? 0)) {
      throw new OAuthError("invalid_grant", {
        description: "This session has ended (password reset or role change). Sign in again.",
        internal: {
          category: "token-exchange-callback",
          reason: "session_version_changed",
          detail: { stored: stored.sessionVersion ?? 0, current: user.sessionVersion },
        },
      });
    }
    fresh = await resolveUserProps(db, user);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("temporarily_unavailable", {
      description: "Could not verify the account right now; retry shortly.",
      statusCode: 503,
      headers: { "Retry-After": "30" },
      internal: { category: "token-exchange-callback", reason: "d1_unavailable", detail: error },
    });
  }
  return { newProps: fresh };
}
