import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

/**
 * OPE-1323 — the OAuth provider's configuration, split out of index.ts so the
 * login-flow tests construct a provider from the SAME options object prod does
 * (index.ts pulls in the Durable Object / agents stack, which node tests can't).
 *
 * 1.x binds every grant and access token to ONE canonical resource and matches
 * it exactly (scheme/host case-folded, empty path == "/"). It is the ORIGIN,
 * not ".../mcp", for two reasons read from prod on 2026-10-06:
 *   1. every live grant in OAUTH_KV stores resource "https://mcp.meetmeatthefair.com/"
 *      (0.x served the origin from /.well-known/oauth-protected-resource), so the
 *      origin keeps existing connector sessions refreshing instead of forcing a
 *      re-authorization through invalid_grant;
 *   2. an origin covers every path, so both apiHandlers keys stay valid
 *      (".../mcp" would make the "/sse" key a construction error).
 *
 * And it is spelled WITH the trailing slash — byte-identical to the stored
 * grants — because 1.x backfills a grant's `resource` to the canonical string
 * whenever the two differ by spelling, and 0.x compared resources with `===`.
 * Without the slash, every refresh under 1.x would rewrite "…com/" to "…com",
 * and a rollback to 0.x would then refuse each such grant with invalid_target
 * for a client that still sends "…com/". With it, refresh writes nothing new to
 * `resource` and rollback reads every grant exactly as 0.x wrote it.
 */
export const MCP_OAUTH_RESOURCE = "https://mcp.meetmeatthefair.com/";

type Handlers<E> = {
  mcp: NonNullable<OAuthProviderOptions<E>["apiHandlers"]>[string];
  sse: NonNullable<OAuthProviderOptions<E>["apiHandlers"]>[string];
  login: OAuthProviderOptions<E>["defaultHandler"];
};

export function mcpOAuthProviderOptions<E>(handlers: Handlers<E>): OAuthProviderOptions<E> {
  return {
    resourceMetadata: { resource: MCP_OAUTH_RESOURCE },
    apiHandlers: {
      "/mcp": handlers.mcp,
      "/sse": handlers.sse,
    },
    defaultHandler: handlers.login,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // OPE-900 step 5 — S256 only. 1.2 removed `allowPlainPKCE` (and the implicit
    // grant) outright: `code_challenge_method=plain` is refused with
    // invalid_request, and passing the option as true throws at construction.
    // The explicit `false` this used to carry is now the library's only
    // behaviour; the login-flow test pins it so a future release cannot quietly
    // re-enable it.
  };
}
