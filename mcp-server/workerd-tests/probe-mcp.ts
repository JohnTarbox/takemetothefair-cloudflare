/**
 * OPE-1391 — a minimal McpAgent for the workerd session-binding tests.
 *
 * The real MeetMeAtTheFairMCP pulls in the whole MCP entry (Workers AI,
 * Workflows, the main-app service binding), none of which runs locally. This
 * class reproduces the one property under test: like MeetMeAtTheFairMCP.init()
 * (src/index.ts), it captures `this.props` ONCE in init() and its `whoami` tool
 * answers from that capture — so a tool call reports whose props the session's
 * Durable Object was started with.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class ProbeMCP extends McpAgent<unknown, Record<string, never>, { userId: string }> {
  server = new McpServer({ name: "probe", version: "1.0.0" }) as never;

  async init() {
    const props = this.props;
    (this.server as unknown as McpServer).tool("whoami", "probe", {}, async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ userId: props?.userId ?? null }) }],
    }));
  }
}
