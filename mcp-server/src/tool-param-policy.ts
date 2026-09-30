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
 *   2. UPDATE/mutation tools WARN — every tool that is neither a listed create
 *      nor a read. The known fields are applied, the unknown ones are named in
 *      `warnings.ignored_params`. A refusal here would throw away the fields
 *      that were right.
 *   3. Read-only tools WARN (batch 3) — so every tool that is not a listed
 *      create warns, and none is left on the SDK's silent strip.
 *
 * Mechanism: the tool is registered exactly as before, then the RegisteredTool
 * it returns is adjusted — for REJECT, `inputSchema` becomes its strict form;
 * for WARN, it becomes the loose form and `handler` is wrapped to strip and
 * name the extras. The SDK reads both fields at REQUEST time (sdk
 * server/mcp.js: tools/list, validateToolInput, executeToolHandler). For
 * REJECT, `tools/list` advertises `additionalProperties: false`, so a
 * schema-respecting client stops sending the key at all, and a key that still
 * arrives is refused before the handler runs. One wrap per McpServer, applied
 * on BOTH transports in index.ts, so no tool file changes and a batch is an
 * edit to this file.
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

export type ParamPolicy = "reject" | "warn";

/**
 * Which policy a tool name gets. Exported so the test can pin the split.
 *
 * Batch 3 (OPE-1132 item 3): read-only tools warn too. There is no third
 * "strip" policy any more — a tool that is not a listed create WARNS, so a
 * tool added later can never land on the SDK's silent default.
 */
export function paramPolicyFor(name: string): ParamPolicy {
  return REJECT_UNKNOWN_PARAMS.has(name) ? "reject" : "warn";
}

type ToolResult = { content?: { type: string; text?: string }[] } & Record<string, unknown>;

/**
 * Put `ignored_params` where the ruling says — `warnings.ignored_params` — on a
 * JSON response, without disturbing a `warnings` the tool already returns:
 *  - no `warnings`, or an object → `warnings.ignored_params = [...]`
 *  - an array (some tools return `warnings: string[]`) → one string appended
 *  - text that is not a JSON object → a second text item, so it still shows
 */
export function withIgnoredParams(result: unknown, ignored: string[]): unknown {
  const r = result as ToolResult | undefined;
  const first = r?.content?.[0];
  const note = `ignored_params: ${ignored.join(", ")} — not declared by this tool, so not applied`;
  if (!r || !Array.isArray(r.content)) return result;
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      const body = JSON.parse(first.text) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const obj = body as Record<string, unknown>;
        const w = obj.warnings;
        if (Array.isArray(w)) obj.warnings = [...w, note];
        else if (w && typeof w === "object") obj.warnings = { ...w, ignored_params: ignored };
        else obj.warnings = { ignored_params: ignored };
        const text = first.text.includes("\n") ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
        return { ...r, content: [{ ...first, text }, ...r.content.slice(1)] };
      }
    } catch {
      // not JSON — fall through to the appended note
    }
  }
  return {
    ...r,
    content: [
      ...r.content,
      { type: "text", text: JSON.stringify({ warnings: { ignored_params: ignored } }) },
    ],
  };
}

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
function shapeOf(schema: unknown): z.ZodRawShape | null {
  const shape = (schema as { _zod?: { def?: { shape?: unknown } } } | undefined)?._zod?.def?.shape;
  return shape && typeof shape === "object" ? (shape as z.ZodRawShape) : null;
}

function strictFormOf(schema: unknown): unknown | null {
  const shape = shapeOf(schema);
  return shape ? z.strictObject(shape) : null;
}

/**
 * Wrap `server.tool` so every tool registers under paramPolicyFor(name). Call
 * once, right after constructing the McpServer and before any register*Tools()
 * call.
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
    const registered = original(name, ...rest) as
      | { inputSchema?: unknown; handler?: (...a: unknown[]) => unknown }
      | undefined;
    if (!registered) return registered;
    const policy = paramPolicyFor(name);
    if (policy === "warn") {
      // No declared shape = no parameters (`server.tool(name, desc, cb)`); the
      // SDK then calls the handler with `extra` only, and there is nothing to
      // compare an argument against. Left as registered.
      const shape = shapeOf(registered.inputSchema);
      const handler = registered.handler;
      if (shape && typeof handler === "function") {
        const known = new Set(Object.keys(shape));
        // Loose, so validation keeps the extra keys long enough to be NAMED;
        // they are stripped again below, so the handler sees exactly what the
        // default strip would have given it.
        registered.inputSchema = z.looseObject(shape);
        registered.handler = async (args: unknown, extra: unknown) => {
          const all = (args ?? {}) as Record<string, unknown>;
          const ignored = Object.keys(all).filter((k) => !known.has(k));
          if (ignored.length === 0) return handler(all, extra);
          const clean = Object.fromEntries(Object.entries(all).filter(([k]) => known.has(k)));
          return withIgnoredParams(await handler(clean, extra), ignored);
        };
      }
    }
    if (policy === "reject") {
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
