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
