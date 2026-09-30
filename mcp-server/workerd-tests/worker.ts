/**
 * OPE-907 — the `main` Worker for the workerd test project.
 *
 * Durable Object classes must be exported from the `main` module for miniflare
 * to instantiate them. This re-exports the REAL class the MCP Worker ships
 * (src/index.ts does the same `export { BurstCounter }`), without pulling in the
 * full MCP entry and the remote-only bindings it expects.
 */
export { BurstCounter } from "../src/burst-counter.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("meetmeatthefair-mcp workerd test worker", { status: 404 });
  },
};
