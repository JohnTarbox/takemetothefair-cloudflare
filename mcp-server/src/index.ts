import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDb } from "./db.js";
import { authenticateToken } from "./auth.js";
import { registerPublicTools } from "./tools/public.js";
import { registerUserTools } from "./tools/user.js";
import { registerVendorTools } from "./tools/vendor.js";
import { registerPromoterTools } from "./tools/promoter.js";
import { registerAdminTools } from "./tools/admin.js";

interface Env {
  DB: D1Database;
}

const ALLOWED_ORIGINS = [
  "https://meetmeatthefair.com",
  "https://www.meetmeatthefair.com",
  "http://localhost:3000",
];

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get("Origin") || "";
  // MCP clients (Claude Desktop) don't send Origin headers — allow those through.
  // For browser requests, only allow known origins.
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    return origin || ALLOWED_ORIGINS[0];
  }
  return ALLOWED_ORIGINS[0];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Only handle the MCP endpoint
    if (url.pathname !== "/mcp") {
      return new Response(JSON.stringify({ error: "Not found. MCP endpoint is /mcp" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const corsOrigin = getCorsOrigin(request);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
          "Access-Control-Expose-Headers": "mcp-session-id",
        },
      });
    }

    const db = getDb(env.DB);

    // Create a fresh MCP server per request
    const server = new McpServer({
      name: "MeetMeAtTheFair",
      version: "1.0.0",
    });

    // Always register public tools
    registerPublicTools(server, db);

    // Authenticate and register role-specific tools
    const authHeader = request.headers.get("Authorization");
    const auth = await authenticateToken(db, authHeader);

    // Always-available diagnostic tool
    server.tool(
      "whoami",
      "Check your authentication status and see which tools are available for your role.",
      {},
      async () => {
        if (!auth) {
          const hasHeader = !!authHeader;
          const headerPrefix = authHeader?.slice(0, 10) || "(none)";
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                authenticated: false,
                reason: !hasHeader
                  ? "No Authorization header received. Make sure your connector is configured with a Bearer token."
                  : `Authorization header received (starts with "${headerPrefix}...") but token validation failed. The token may be revoked or invalid. Generate a new one at /dashboard/settings.`,
                tools: "public only (search_events, get_event_details, list_event_vendors, search_vendors, search_venues)",
              }, null, 2),
            }],
          };
        }

        const roleTools: Record<string, string[]> = {
          USER: ["get_my_favorites", "toggle_favorite"],
          VENDOR: ["get_my_vendor_profile", "update_vendor_profile", "list_my_applications", "apply_to_event", "withdraw_application", "suggest_event"],
          PROMOTER: ["list_my_events", "get_event_applications"],
          ADMIN: ["list_all_events", "update_event_status", "list_event_vendors_admin", "update_vendor_status"],
        };

        const available = ["public tools (5)"];
        available.push("user tools (2)");
        if (auth.role === "VENDOR" || auth.role === "ADMIN") available.push("vendor tools (6)");
        if (auth.role === "PROMOTER" || auth.role === "ADMIN") available.push("promoter tools (2)");
        if (auth.role === "ADMIN") available.push("admin tools (4)");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              authenticated: true,
              userId: auth.userId,
              role: auth.role,
              vendorId: auth.vendorId || null,
              promoterId: auth.promoterId || null,
              toolSets: available,
            }, null, 2),
          }],
        };
      },
    );

    if (auth) {
      registerUserTools(server, db, auth);

      if (auth.role === "VENDOR" || auth.role === "ADMIN") {
        registerVendorTools(server, db, auth);
      }

      if (auth.role === "PROMOTER" || auth.role === "ADMIN") {
        registerPromoterTools(server, db, auth);
      }

      if (auth.role === "ADMIN") {
        registerAdminTools(server, db, auth);
      }
    }

    // Create web-standard transport (stateless — no session tracking)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);

    const response = await transport.handleRequest(request);

    // Add CORS headers
    const corsHeaders = new Headers(response.headers);
    corsHeaders.set("Access-Control-Allow-Origin", corsOrigin);
    corsHeaders.set("Access-Control-Expose-Headers", "mcp-session-id");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: corsHeaders,
    });
  },
} satisfies ExportedHandler<Env>;
