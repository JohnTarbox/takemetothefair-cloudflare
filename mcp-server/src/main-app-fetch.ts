/**
 * OPE-258 — the one way the MCP Worker talks to the main app.
 *
 * ## The bug this exists to fix
 *
 * MCP→main-app subrequests carrying `X-Internal-Key` returned **401 only when
 * issued from the `fetch()` handler** (the legacy `mmatf_` tool path), while
 * byte-identical calls from `scheduled()` / workflows / the OAuth Durable
 * Object were accepted. Verified across three investigation cycles:
 *
 *   - the key value is IDENTICAL across entrypoints (sha256 prefix `fb5f62c4`,
 *     len 64 from both `fetch` and `scheduled`) — not an env divergence
 *   - no `[vars]` shadows the secret; both hold it as `secret_text`
 *   - it reproduces on a freshly-deployed isolate — not a stale isolate
 *   - the failing and working routes share ONE comparison (`internalKeyMatches`
 *     in the main app) — not an endpoint or middleware difference
 *   - crons are demonstrably healthy: the `*​/10` kpi cron wrote
 *     `admin_actions` at 2026-07-28T00:30:05Z, and there are zero
 *     `mcp:schedule:*` auth errors in 7 days
 *
 * The only remaining variable is the Cloudflare execution context: the fetch
 * handler issues its subrequest while handling an inbound client request; the
 * scheduled handler has no ambient inbound request.
 *
 * ## The fix
 *
 * Stop depending on that context. A **service binding** is a direct
 * Worker-to-Worker invocation — it never traverses DNS, the edge, or any
 * routing layer that could differ between entrypoints. It is also faster and
 * cheaper than a public round-trip on our own zone.
 *
 * The binding was previously commented out in `mcp-server/wrangler.toml` with
 * the reason: *"our main app is on Pages, which needs a different binding
 * syntax that's still TBD."* **That blocker is obsolete** — since the
 * 2026-06-10 OpenNext cutover the main app is the `meetmeatthefair-app`
 * Worker (confirmed present in the account), which is an ordinary service
 * binding target.
 *
 * ## Belt and braces
 *
 * A binding failure falls back to the public URL rather than throwing, so this
 * is strictly safer than the previous `env.MAIN_APP ? binding : fetch` with no
 * fallback. And every call stamps `X-MMATF-Entrypoint`, so if a 401 ever
 * recurs the main app's `api-auth:internal-key-refused` log names the
 * entrypoint that produced it instead of leaving us to guess again.
 */

/** Which Worker entrypoint issued the call. The dimension OPE-258 lacked. */
export type McpEntrypoint = "fetch" | "scheduled" | "queue" | "workflow" | "durable-object";

export interface MainAppEnv {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  MAIN_APP?: { fetch: (req: Request) => Promise<Response> };
}

export interface MainAppFetchOptions {
  method?: string;
  /** Extra headers. `X-Internal-Key` and the entrypoint stamp are added here. */
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

/**
 * Call a main-app route with internal-key auth.
 *
 * `path` is an absolute path (`/api/admin/...`). Returns the raw Response so
 * callers keep their own status/parse handling.
 *
 * Throws only if neither transport is configured — an unconfigured worker is a
 * deployment error worth surfacing, unlike a transient binding hiccup.
 */
export async function mainAppFetch(
  env: MainAppEnv,
  path: string,
  entrypoint: McpEntrypoint,
  options: MainAppFetchOptions = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
    "X-MMATF-Entrypoint": entrypoint,
  };
  // Hostname is irrelevant to a service binding, but Request requires a valid
  // URL — use the public host so the route resolves identically either way.
  const url = `${env.MAIN_APP_URL || "https://meetmeatthefair.com"}${path}`;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    ...(options.body != null ? { body: options.body } : {}),
  };

  if (env.MAIN_APP) {
    try {
      return await env.MAIN_APP.fetch(new Request(url, init));
    } catch {
      // Fall through to the public path — a binding blip must not take out a
      // working call. The previous code had no such fallback.
    }
  }

  if (!env.INTERNAL_API_KEY) {
    throw new Error("mainAppFetch: INTERNAL_API_KEY is not configured on the MCP Worker.");
  }
  return fetch(url, init);
}
