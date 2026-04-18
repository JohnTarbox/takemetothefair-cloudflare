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

    // Public tools — always available
    registerPublicTools(this.server, db);

    // Diagnostic tool
    const props = this.props;
    this.server.tool(
      "whoami",
      "Check your authentication status and see which tools are available.",
      {},
      async () => {
        if (!props) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ authenticated: false }, null, 2) },
            ],
          };
        }
        const toolSets = ["public tools (10)", "user tools (2)"];
        if (props.role === "VENDOR" || props.role === "ADMIN") {
          toolSets.push(
            props.vendorId
              ? "vendor tools (6)"
              : "vendor tools (1 — suggest_event only, no vendor profile)"
          );
        }
        if (props.role === "PROMOTER" || props.role === "ADMIN")
          toolSets.push("promoter tools (3)");
        if (props.role === "ADMIN") toolSets.push("admin tools (13)", "blog tools (6)");
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
                  toolSets,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Role-specific tools based on OAuth props
    if (this.props) {
      const auth: AuthContext = {
        userId: this.props.userId,
        role: this.props.role as AuthContext["role"],
        vendorId: this.props.vendorId,
        promoterId: this.props.promoterId,
      };

      registerUserTools(this.server, db, auth);

      if (auth.role === "VENDOR" || auth.role === "ADMIN") {
        console.log(
          `[INIT] Registering vendor tools for role=${auth.role} vendorId=${auth.vendorId || "none"}`
        );
        registerVendorTools(this.server, db, auth);
      }
      if (auth.role === "PROMOTER" || auth.role === "ADMIN") {
        registerPromoterTools(this.server, db, auth);
      }
      if (auth.role === "ADMIN") {
        registerAdminTools(this.server, db, auth, this.env);
        registerBlogTools(this.server, db, auth, this.env);
        registerContentLinksTools(this.server, db, auth);
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
    if (auth.role === "VENDOR" || auth.role === "ADMIN") registerVendorTools(server, db, auth);
    if (auth.role === "PROMOTER" || auth.role === "ADMIN") registerPromoterTools(server, db, auth);
    if (auth.role === "ADMIN") {
      registerAdminTools(server, db, auth, env);
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
