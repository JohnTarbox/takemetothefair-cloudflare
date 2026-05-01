// Shim — schema source of truth lives in packages/db-schema/.
// Existing relative imports inside mcp-server continue to work via this
// re-export. Once all MCP files import directly from the workspace package,
// this shim can be deleted.
export * from "@takemetothefair/db-schema";
