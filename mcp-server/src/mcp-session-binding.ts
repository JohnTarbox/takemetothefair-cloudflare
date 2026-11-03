/**
 * OPE-1391 — bind every MCP session Durable Object to the user who opened it.
 *
 * ## The hole (agents@0.28.1, read from the installed source)
 *
 * `McpAgent.serve()` / `serveSSE()` address the session's Durable Object purely
 * by the client-supplied session id:
 *
 *   - streamable HTTP: `getAgentByName(ns, \`streamable-http:${mcp-session-id}\`,
 *     { props: ctx.props })` for POST / GET / DELETE
 *     (node_modules/agents/dist/mcp/index.js:177, :298, :368);
 *   - legacy SSE: the session id is even taken from `?sessionId=` on the GET
 *     (mcp/index.js:406) and again on POST /sse/message (:474, :480).
 *
 * The caller's `ctx.props` (the OAuth user) only reaches the object through
 * `__unsafe_ensureInitialized(props)` → `Lifecycle.start(props)`, which IGNORES
 * props once startup has run (lifecycle-DGorpAmA.js:1073-1074). `McpAgent.onStart`
 * stores the FIRST activator's props (mcp/index.js:1450-1452), and
 * `MeetMeAtTheFairMCP.init()` registers role-gated tools from `this.props` once
 * (src/index.ts). So a request carrying user B's valid token and user A's
 * session id ran as A on a warm object — and on a cold one, B's props
 * overwrote A's stored props.
 *
 * ## The fix — the owner is part of the object's NAME
 *
 * The handler is given a namespace whose `idFromName(name)` addresses
 * `${name}:owner-<sha256(userId)[:32]>`. Every lookup the library makes —
 * initialize, follow-up POST, GET listen stream, DELETE, SSE connect and SSE
 * message — goes through `getAgentByName` → `idFromName` (agent-routing.js:178),
 * so user B presenting A's session id reaches B's OWN, uninitialized object and
 * gets the library's own `404 Session not found` — indistinguishable from an id
 * that never existed, so an id is not confirmable. A's object is never touched,
 * warm or cold: there is no props race to win.
 *
 * The session id the client sees is unchanged. The suffix is appended after a
 * `:`, and the library reads the transport type / session id as the first two
 * `:`-separated fields of the object's name (mcp/index.js:1369-1385), so both
 * still read `streamable-http` / `sse` and the client's id.
 *
 * The suffix is a fixed-length hex digest and always LAST, so no client-chosen
 * session id can make B's name equal A's (the trailing 39 characters are B's
 * tag whatever the id says).
 *
 * The legacy `mmatf_` Bearer path never reaches this: it is a stateless
 * per-request McpServer with `sessionIdGenerator: undefined` (src/index.ts,
 * `handleLegacyMcpRequest`) — no Durable Object, no session id to steal.
 */

export const SESSION_OWNER_SEPARATOR = ":owner-";
const OWNER_TAG_HEX_CHARS = 32;

/** Fixed-length, non-reversible owner tag for a user id. */
export async function sessionOwnerTag(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mcp-session-owner:${userId}`)
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, OWNER_TAG_HEX_CHARS);
}

export function ownerBoundName(name: string, tag: string): string {
  return `${name}${SESSION_OWNER_SEPARATOR}${tag}`;
}

/**
 * A namespace that addresses every NAMED object under the owner's tag.
 * Delegates with explicit calls (not a prototype chain) because the native
 * binding's methods brand-check `this`.
 */
export function ownerBoundNamespace(
  ns: DurableObjectNamespace,
  tag: string
): DurableObjectNamespace {
  const idFromName = (name: string) => ns.idFromName(ownerBoundName(name, tag));
  const bound = {
    idFromName,
    newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => ns.newUniqueId(options),
    idFromString: (id: string) => ns.idFromString(id),
    get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
      ns.get(id, options),
    getByName: (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
      ns.get(idFromName(name), options),
    jurisdiction: (j: DurableObjectJurisdiction) => ownerBoundNamespace(ns.jurisdiction(j), tag),
  };
  return bound as unknown as DurableObjectNamespace;
}

interface ApiFetchHandler<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
}

function noOwnerResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: no authenticated user for this session" },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Wrap a `McpAgent.serve()` / `serveSSE()` handler so its Durable Object
 * namespace (`binding`) is bound to the authenticated user in `ctx.props.userId`
 * (set by OAuthProvider before it calls an apiHandler). No user id → 401; the
 * library is never reached with an unbound namespace.
 */
export function bindMcpSessionsToUser<E extends object>(
  handler: ApiFetchHandler<E>,
  binding = "MCP_OBJECT"
): ApiFetchHandler<E> {
  return {
    async fetch(request, env, ctx) {
      const userId = (ctx as { props?: { userId?: unknown } }).props?.userId;
      if (typeof userId !== "string" || userId.length === 0) return noOwnerResponse();
      const ns = (env as Record<string, unknown>)[binding] as DurableObjectNamespace | undefined;
      if (!ns) return handler.fetch(request, env, ctx); // library throws its own binding error
      const bound = ownerBoundNamespace(ns, await sessionOwnerTag(userId));
      const boundEnv = new Proxy(env, {
        get: (target, prop) => (prop === binding ? bound : Reflect.get(target, prop, target)),
      });
      return handler.fetch(request, boundEnv, ctx);
    },
  };
}
