/**
 * Re-export shim. The canonical `decideDiscoveryRouting` now lives in the shared
 * `@takemetothefair/utils` package so the MCP server's suggest_event path can
 * import it (mcp-server is a separate workspace that can't reach src/). Existing
 * `@/lib/series/discovery-routing` imports + the colocated test keep working.
 */
export {
  decideDiscoveryRouting,
  type DiscoveryMatch,
  type DiscoveryRouting,
} from "@takemetothefair/utils";
