/**
 * OPE-1132 — what a tool does with a parameter it does not declare.
 *
 * `server.tool(name, description, rawShape, cb)` builds `z.object(rawShape)`,
 * and Zod's default is to STRIP unknown keys before the handler runs. A
 * caller's typo, or a sibling tool's vocabulary, vanishes without a word and
 * the call reports success. OPE-1090 is the specimen: a one-call create_vendor
 * landed a PUBLIC vendor row with five NULLs and `created: true`.
 *
 * John's ruling on OPE-1132 (2026-09-23), rolled out in batches:
 *   1. CREATE tools REJECT an unknown parameter — nothing is written, and the
 *      error names the key. A half-empty row is public on insert; an error is
 *      the thing a caller can correct.
 *   2. UPDATE/mutation tools WARN (later batch).
 *   3. Read-only tools WARN (later batch).
 *
 * Mechanism: the tool is registered exactly as before, then the `inputSchema`
 * on the RegisteredTool it returns is replaced with its strict form. The
 * SDK reads that field at REQUEST time for both `tools/list` (so the schema
 * advertises `additionalProperties: false` and a schema-respecting client
 * stops sending the key at all) and `tools/call` validation (so a key that
 * still arrives is refused before the handler runs). One wrap per McpServer,
 * applied on BOTH transports in index.ts, so no tool file changes and a batch
 * is an edit to the set below.
 *
 * `create_vendor` is not listed: OPE-1093 registers it with `registerTool` and
 * a `.strict()` schema of its own, which this wrap does not touch.
 */

import { z } from "zod";

/** Batch 1 — tools that INSERT a new row. */
export const REJECT_UNKNOWN_PARAMS: ReadonlySet<string> = new Set([
  "add_event_name_variant",
  "add_market_player_snapshot",
  "add_syndication_subscription",
  "apply_to_event",
  "bulk_create_event_citations",
  "compose_operator_email",
  "cpi_record_filing",
  "create_blog_post",
  "create_claim_invite",
  "create_discrepancy",
  "create_event_citation",
  "create_event_day",
  "create_occurrence",
  "create_or_link_performer",
  "create_or_link_vendor",
  "create_performer",
  "create_promoter",
  "create_venue",
  "log_vendor_outreach",
  "record_agent_heartbeat",
  "record_crossing",
  "record_market_player_serp_rank",
  "record_tentative_check",
  "register_syndication_subscriber",
  "suggest_event",
]);

type ToolRegistrar = {
  tool: (name: string, ...rest: unknown[]) => unknown;
};

/**
 * The strict form of a registered tool's input schema, or null if it has no
 * object shape to be strict about.
 *
 * NOT `schema.strict()`: for a Zod 4 raw shape the SDK builds the object with
 * `zod/v4-mini` (sdk server/zod-compat.js `objectFromShape`), which has no
 * `.strict()` method at all. So the shape is read back off the built object and
 * rebuilt with classic Zod's `z.strictObject` — the same field schemas, the
 * same validation, plus the refusal of unknown keys.
 */
function strictFormOf(schema: unknown): unknown | null {
  const shape = (schema as { _zod?: { def?: { shape?: unknown } } } | undefined)?._zod?.def?.shape;
  if (!shape || typeof shape !== "object") return null;
  return z.strictObject(shape as z.ZodRawShape);
}

/**
 * Wrap `server.tool` so every tool in REJECT_UNKNOWN_PARAMS registers with a
 * strict input schema. Call once, right after constructing the McpServer and
 * before any register*Tools() call.
 *
 * Throws at registration if a listed tool ends up without a strictable schema
 * — a listed tool that silently stayed permissive is the exact failure this
 * file exists to remove, so it must not be possible quietly.
 */
export function applyToolParamPolicy<S extends object>(server: S): S {
  // Typed loosely on purpose: McpServer's `tool()` is a set of overloads, which
  // no single function type matches, so a `S extends ToolRegistrar` bound would
  // widen every caller's McpServer down to the bound.
  const registrar = server as unknown as ToolRegistrar;
  const original = registrar.tool.bind(registrar);
  registrar.tool = (name: string, ...rest: unknown[]) => {
    const registered = original(name, ...rest) as { inputSchema?: unknown } | undefined;
    if (REJECT_UNKNOWN_PARAMS.has(name) && registered) {
      const strict = strictFormOf(registered.inputSchema);
      if (!strict) {
        throw new Error(
          `OPE-1132: ${name} is listed to reject unknown parameters but registered without an object input schema`
        );
      }
      registered.inputSchema = strict;
    }
    return registered;
  };
  return server;
}
