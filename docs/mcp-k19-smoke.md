# K19 wrong-echo smoke runbook

Quick validation that the MCP transport routing wrap correctly delivers each tool response to its originating connection under concurrent parallel calls. Used to baseline before the K19 fix deploys, and to confirm closure after.

## Background

K19 (surfaced 2026-06-04) was framed as "`create_vendor` / `update_vendor_status` echo the wrong entity under concurrent admin writes." Root cause was a coverage gap in the PR #221 transport-routing wrap (`mcp-server/src/index.ts`): the intake map was single-valued, so two concurrent intakes with the same JSON-RPC id overwrote each other and a response could be routed to the sibling subagent's socket. See `[[project_k19_transport_routing_coverage_gap]]` for the full mechanism.

The K19 fix (committed 2026-06-07) upgrades the intake map to a Set and reads `getCurrentAgent().connection?.id` at send-time as the primary disambiguating signal. Each response is delivered to its own connection via `sendTimeContext` (strong signal) or `intakeIntersection` (fallback), or — if neither signal disambiguates — fails loud with an `ambiguous` JSON-RPC error rather than silently misrouting.

## Why this is a runbook, not a script

The bug lives on the OAuth-DO path (`mcp.meetmeatthefair.com/mcp` via OAuth, the path Claude.ai's connector uses). The legacy `mmatf_` Bearer-token path at `handleLegacyMcpRequest` creates a fresh `McpServer` + transport per request, so it has no cross-request state to corrupt — a curl-based smoke against it would never reproduce K19 even if the bug were back.

So the smoke MUST run from a real OAuth client. A Claude session with the MMATF connector enabled is the simplest reproducible environment.

## Smoke procedure

### Baseline (read-only, low-risk)

Goal: verify request/response identity holds across 20+ truly-parallel read calls. Doesn't conclusively reproduce K19 (John's original repro needed 72 writes across 3 subagent connections), but a clean run establishes the baseline; a dirty run is a strong K19 signal that needs immediate attention.

1. In a Claude session connected to the MMATF MCP server, call `search_vendors(limit: 20)` to collect 20 distinct slugs.
2. In a SINGLE Claude turn, issue 20 parallel `get_vendor_details(slug: <each-slug>)` calls — all in one tool-use block, NOT serialized.
3. For each response, confirm the returned `slug` field equals the requested `slug`. Any mismatch = K19 reproducing on the read path (which would mean the bug is more severe than the original framing).

Last clean baseline: 20/20 match (2026-06-07, prod still on pre-K19 wrap).

### Write-path smoke (post-deploy ONLY)

Goal: exercise the original K19 surface (`create_vendor` under concurrent admin writes). Run this AFTER the K19 fix is deployed to prod — running it pre-deploy on prod risks the same data corruption that surfaced the bug.

1. In one Claude turn, issue 30 parallel `create_vendor(business_name: "K19 Smoke Test Vendor <N>", type: "Other", defer_search_ping: true)` calls with distinct `<N>` (1–30).
2. For each response, confirm `business_name` and `slug` echo the requested name. Track any mismatch by `id`.
3. Cleanup: call `delete_vendor` on each created id. (Or use `search_vendors` with `query: "K19 Smoke Test"` to find them.)
4. Tail `wrangler tail meetmeatthefair-mcp` during the run; look for `[MCP/#121]` lines:
   - `collision routed to connection X via sendTimeContext` — fix working, ALS propagating cleanly
   - `collision routed to connection X via intakeIntersection` — fix working, ALS lost on this path, intake-set saved us
   - `response routing ambiguous ...` — fix detected an unfixable collision, threw to caller (caller should retry)

### Higher-concurrency smoke (matches original repro)

If you need to reproduce John's exact 2026-06-04 conditions:

1. Spawn 3 Claude subagents from one session, each with the MMATF connector.
2. Have each subagent run the 24-call create_vendor smoke from the section above with distinct name prefixes ("Smoke-A-N", "Smoke-B-N", "Smoke-C-N").
3. All three subagents start within ~1 second.
4. Verify each subagent's responses match its requests; cleanup created vendors.

This is the only known shape that reliably triggered the pre-fix wrong-echo. If a post-deploy run shows zero mismatches across all three subagents, K19 is conclusively closed.

## What to look for in production logs

Per the K19 fix's added observability:

```bash
# Tail MCP Worker logs (requires CF auth)
npx wrangler tail meetmeatthefair-mcp --format pretty
```

Expected log shapes after the fix is live:

| Pattern                                                                                    | Meaning                                                                                               |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `[MCP/#121] collision routed to connection <id> via sendTimeContext for request id <N>`    | Fix engaged via send-time `getCurrentAgent()`. ALS is propagating cleanly. Most common shape.         |
| `[MCP/#121] collision routed to connection <id> via intakeIntersection for request id <N>` | Fix engaged via intake-set fallback. ALS broke on this path; investigate if frequent.                 |
| `[MCP/#121] response routing ambiguous for request id <N> ...`                             | Fix refused to route. Loud error returned to caller. Investigate cluster.                             |
| (no `[MCP/#121]` lines)                                                                    | No collisions are occurring. Either traffic is below collision threshold or upstream SDK fixed #1186. |

Track frequency over a week — `sendTimeContext` should dominate. A rising share of `intakeIntersection` or any `ambiguous` cluster warrants a memory entry update.

## Related

- Source: `mcp-server/src/transport-collision-fix.ts`, `mcp-server/src/index.ts:324-443`
- Tests: `mcp-server/__tests__/transport-collision-fix.test.ts`
- Memory: `[[project_k19_transport_routing_coverage_gap]]`, `[[feedback_documented_test_limitations_dont_fix_themselves]]`
- Original PR #221 (2026-05-24): first transport-routing fix; the gap K19 closed
- Upstream: `@modelcontextprotocol/sdk` #1186
