import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoginHandler } from "./oauth/login-handler.js";
import { getDb } from "./db.js";
import { authenticateToken } from "./auth.js";
import { registerPublicTools } from "./tools/public.js";
import { registerUserTools } from "./tools/user.js";
import { registerVendorTools } from "./tools/vendor.js";
import { registerPromoterTools } from "./tools/promoter.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerBlogTools } from "./tools/blog.js";
import { registerContentLinksTools } from "./tools/content-links.js";
import type { AuthContext } from "./auth.js";
import type { UserProps } from "./oauth/utils.js";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
  // Optional Pages service binding — bound in production via wrangler.toml,
  // typically absent in local dev. When present, internal API calls (IndexNow
  // ping, future cross-Worker calls) skip the public-internet round-trip.
  MAIN_APP?: Fetcher;
  // Build fingerprint — injected by `wrangler deploy --var` at deploy time.
  // Empty in local dev; populated in production so `whoami` can answer
  // "which bundle is the server running?" without a client round-trip.
  GIT_SHA?: string;
  BUILD_TIME?: string;
}

// ---------------------------------------------------------------------------
// Durable Object — MCP agent with OAuth-provided user props
// ---------------------------------------------------------------------------
export class MeetMeAtTheFairMCP extends McpAgent<Env, Record<string, never>, UserProps> {
  // Type assertion needed: @modelcontextprotocol/sdk and agents bundle separate
  // copies of McpServer with incompatible private fields but identical public API.
  server = new McpServer({
    name: "MeetMeAtTheFair",
    version: "1.0.0",
  }) as any;

  async init() {
    const db = getDb(this.env.DB);

    // Track which tools each register*() call added, so `whoami` can report
    // counts and names sourced from the live McpServer registry — the same
    // registry that `tools/list` iterates. Hardcoded counts drift silently;
    // this can't.
    const snapshot = (): Set<string> =>
      new Set(Object.keys((this.server as any)._registeredTools ?? {}));
    const diff = (before: Set<string>): string[] => [...snapshot()].filter((n) => !before.has(n));
    const groups: Record<string, string[]> = {};

    // Public tools — always available
    let before = snapshot();
    registerPublicTools(this.server, db);
    groups.public = diff(before);

    // Diagnostic tool — registered before role-gated tools, but reads `groups`
    // at call time via closure, so later register*() calls populate it.
    const props = this.props;
    const env = this.env;
    const build = {
      serverName: "MeetMeAtTheFair",
      serverVersion: "1.0.0",
      gitSha: env.GIT_SHA || "unknown",
      buildTime: env.BUILD_TIME || "unknown",
    };
    before = snapshot();
    this.server.tool(
      "whoami",
      "Check your authentication status and see which tools are available.",
      {},
      async () => {
        if (!props) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ authenticated: false, build }, null, 2),
              },
            ],
          };
        }
        const toolSets: string[] = [
          `public tools (${groups.public.length})`,
          `user tools (${groups.user?.length ?? 0})`,
        ];
        if (groups.vendor?.length) {
          toolSets.push(
            props.vendorId
              ? `vendor tools (${groups.vendor.length})`
              : `vendor tools (${groups.vendor.length} — suggest_event only, no vendor profile)`
          );
        }
        if (groups.promoter?.length) toolSets.push(`promoter tools (${groups.promoter.length})`);
        if (groups.admin?.length) toolSets.push(`admin tools (${groups.admin.length})`);
        if (groups.analytics?.length) toolSets.push(`analytics tools (${groups.analytics.length})`);
        if (groups.blog?.length) toolSets.push(`blog tools (${groups.blog.length})`);
        if (groups.contentLinks?.length)
          toolSets.push(`content-links tools (${groups.contentLinks.length})`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  authenticated: true,
                  userId: props.userId,
                  email: props.email,
                  role: props.role,
                  vendorId: props.vendorId || null,
                  promoterId: props.promoterId || null,
                  build,
                  toolSets,
                  tools: {
                    public: groups.public,
                    diagnostic: groups.diagnostic ?? [],
                    user: groups.user ?? [],
                    vendor: groups.vendor ?? [],
                    promoter: groups.promoter ?? [],
                    admin: groups.admin ?? [],
                    analytics: groups.analytics ?? [],
                    blog: groups.blog ?? [],
                    contentLinks: groups.contentLinks ?? [],
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
    groups.diagnostic = diff(before);

    // Role-specific tools based on OAuth props
    if (this.props) {
      const auth: AuthContext = {
        userId: this.props.userId,
        role: this.props.role as AuthContext["role"],
        vendorId: this.props.vendorId,
        promoterId: this.props.promoterId,
      };

      before = snapshot();
      registerUserTools(this.server, db, auth);
      groups.user = diff(before);

      if (auth.role === "VENDOR" || auth.role === "ADMIN") {
        console.log(
          `[INIT] Registering vendor tools for role=${auth.role} vendorId=${auth.vendorId || "none"}`
        );
        before = snapshot();
        registerVendorTools(this.server, db, auth, this.env);
        groups.vendor = diff(before);
      }
      if (auth.role === "PROMOTER" || auth.role === "ADMIN") {
        before = snapshot();
        registerPromoterTools(this.server, db, auth);
        groups.promoter = diff(before);
      }
      if (auth.role === "ADMIN") {
        before = snapshot();
        registerAdminTools(this.server, db, auth, this.env);
        groups.admin = diff(before);

        before = snapshot();
        registerAnalyticsTools(this.server, auth, this.env);
        groups.analytics = diff(before);

        before = snapshot();
        registerBlogTools(this.server, db, auth, this.env);
        groups.blog = diff(before);

        before = snapshot();
        registerContentLinksTools(this.server, db, auth);
        groups.contentLinks = diff(before);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth provider — handles /register, /authorize, /token, and routes /mcp to DO
// ---------------------------------------------------------------------------
const oauthProvider = new OAuthProvider({
  apiHandlers: {
    "/mcp": MeetMeAtTheFairMCP.serve("/mcp"),
    "/sse": MeetMeAtTheFairMCP.serveSSE("/sse"),
  },
  defaultHandler: LoginHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

// ---------------------------------------------------------------------------
// CORS helpers (for legacy mmatf_ token requests)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://meetmeatthefair.com",
  "https://www.meetmeatthefair.com",
  "http://localhost:3000",
];

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get("Origin") || "";
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    return origin || ALLOWED_ORIGINS[0];
  }
  return ALLOWED_ORIGINS[0];
}

// ---------------------------------------------------------------------------
// Legacy stateless handler for mmatf_ Bearer tokens
// ---------------------------------------------------------------------------
async function handleLegacyMcpRequest(request: Request, env: Env): Promise<Response> {
  const { WebStandardStreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");

  const corsOrigin = getCorsOrigin(request);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
        "Access-Control-Expose-Headers": "mcp-session-id",
      },
    });
  }

  const db = getDb(env.DB);
  const server = new McpServer({ name: "MeetMeAtTheFair", version: "1.0.0" });

  registerPublicTools(server, db);

  const authHeader = request.headers.get("Authorization");
  const auth = await authenticateToken(db, authHeader);

  if (auth) {
    registerUserTools(server, db, auth);
    if (auth.role === "VENDOR" || auth.role === "ADMIN") registerVendorTools(server, db, auth, env);
    if (auth.role === "PROMOTER" || auth.role === "ADMIN") registerPromoterTools(server, db, auth);
    if (auth.role === "ADMIN") {
      registerAdminTools(server, db, auth, env);
      registerAnalyticsTools(server, auth, env);
      registerBlogTools(server, db, auth, env);
      registerContentLinksTools(server, db, auth);
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const response = await transport.handleRequest(request);

  const corsHeaders = new Headers(response.headers);
  corsHeaders.set("Access-Control-Allow-Origin", corsOrigin);
  corsHeaders.set("Access-Control-Expose-Headers", "mcp-session-id");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: corsHeaders,
  });
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const authHeader = request.headers.get("Authorization");

    // Log all requests for debugging
    console.log(`[MCP] ${request.method} ${url.pathname} auth=${authHeader ? "yes" : "no"}`);

    // Root URL health check — Claude.ai probes this before starting OAuth
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({ name: "MeetMeAtTheFair", version: "1.0.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Public build-fingerprint endpoint — no auth, no MCP protocol. Any client
    // can curl this and compare gitSha to `git log` on the repo to verify they
    // are talking to the latest deployed bundle.
    if (url.pathname === "/version" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          name: "MeetMeAtTheFair",
          serverVersion: "1.0.0",
          gitSha: env.GIT_SHA || "unknown",
          buildTime: env.BUILD_TIME || "unknown",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Legacy mmatf_ tokens bypass OAuth and use the stateless handler
    if (url.pathname === "/mcp" && authHeader?.includes("mmatf_")) {
      return handleLegacyMcpRequest(request, env);
    }

    // Everything else goes through the OAuth provider
    try {
      const response = await oauthProvider.fetch(request, env, ctx);
      console.log(`[MCP] ${url.pathname} → ${response.status}`);
      return response;
    } catch (err: any) {
      console.error("[MCP] OAuthProvider error:", err?.message, err?.stack);
      return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
