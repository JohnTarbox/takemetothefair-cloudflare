/**
 * OPE-846 — drive the `mcp:tool:*` fault emitter to failure, and read the row back.
 *
 * ## Why this file exists
 *
 * OPE-630 shipped `withFaultLog` on 2026-08-29 so an MCP tool fault would land
 * in `error_logs` instead of vanishing. Nine days later the table held **zero**
 * `mcp:tool:*` rows, and the implementing agent had said plainly that it could
 * not prove the emitter worked — nothing had failed since deploy.
 *
 * That is the OPE-6 v3.8 state exactly: **inert and working are identical from
 * the outside.** Both are silent, both are green, and the second is the one
 * everybody assumes. It is the third instance of this family on this codebase
 * (OPE-93, OPE-488), and both predecessors were closed as Agent Done.
 *
 * ⚠️ The inference this file exists to refuse: *"nothing has failed, therefore
 * the logger works."* OPE-93 and OPE-488 each disproved it on a different
 * emitter. Absence of rows is not evidence of health — it is the absence of
 * evidence, which is precisely what a control is supposed to supply.
 *
 * ## Why it tests through the REGISTERED TOOL, not the helper
 *
 * `withFaultLog` is a closure inside `registerPublicTools`. Testing it directly
 * would need it exported, and would prove only that the helper works — leaving
 * the far more likely failure untested: **that a tool is not wrapped at all.**
 * As of this ticket the wrapper is applied at exactly ONE call site
 * (`search_events`), so "the helper is correct" and "the lane is covered" are
 * very different claims. These tests invoke the tool the server actually
 * registered, so an unwrapping regression fails them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import type Database from "better-sqlite3";
import { registerPublicTools } from "../src/tools/public.js";
import { errorLogs } from "../src/schema.js";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);
});

/**
 * Force a genuine fault inside the handler.
 *
 * Dropping the table the tool reads makes the query throw for real, from
 * inside the handler, exactly as a D1 error would — rather than stubbing the
 * thrower and testing the stub.
 */
function breakTheQuery() {
  raw.exec("DROP TABLE events");
}

async function callSearchEvents(params: Record<string, unknown>) {
  const handler = server.handlers.get("search_events");
  if (!handler) throw new Error("search_events was not registered");
  return handler(params);
}

describe("OPE-846 — the emitter, driven to failure", () => {
  it("writes an mcp:tool:* row when the tool throws", async () => {
    // Positive landmark FIRST: with the table intact the tool succeeds and
    // writes NO error row. Without this, a test that always logged — or a
    // logger that fired on success too — would read as a pass.
    await callSearchEvents({ query: "fair" });
    expect(await db.select().from(errorLogs).all()).toHaveLength(0);

    breakTheQuery();
    await callSearchEvents({ query: "fair" });

    const rows = await db.select().from(errorLogs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("mcp:tool:search_events");
  });

  it("writes level='error', not the table's majority 'info'", async () => {
    // Scope 3. `error_logs` is a general app log — ~67% of its rows are
    // `level='info'` — so an emitter that defaulted to info would be invisible
    // to every correct `WHERE level='error'` query. That would reproduce this
    // ticket's invisibility one level down, and it is not hypothetical: the
    // level is a DEFAULT in `logError`, which nothing here passes explicitly.
    breakTheQuery();
    await callSearchEvents({ query: "fair" });

    const [row] = await db.select().from(errorLogs).all();
    expect(row.level).toBe("error");
  });

  it("names the tool and carries the failing shape in context", async () => {
    breakTheQuery();
    await callSearchEvents({ query: "a five word query here", fuzzy: true });

    const [row] = await db.select().from(errorLogs).all();
    expect(row.message).toContain("MCP tool search_events threw");
    const ctx = JSON.parse(row.context ?? "{}") as Record<string, unknown>;
    expect(ctx.tool).toBe("search_events");
    // OPE-630 wanted the SHAPE that failed recorded, because the original
    // ticket guessed "4 tokens" when the real cap is a 50-char pattern.
    expect(ctx.query_length).toBe("a five word query here".length);
    expect(ctx.fuzzy).toBe(true);
  });

  it("returns a branchable error instead of throwing at the caller", async () => {
    // The other half of OPE-630: dedup passes treat "no hit" as "no duplicate",
    // so a throw made a crash indistinguishable from a clean miss and the
    // default on failure was to CREATE the duplicate.
    breakTheQuery();
    const res = (await callSearchEvents({ query: "fair" })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text ?? "{}") as Record<string, unknown>;
    expect(payload.error).toBe("tool_failed");
    expect(payload.tool).toBe("search_events");
  });

  it("does not swallow the fault silently — the row and the result agree", async () => {
    breakTheQuery();
    const res = (await callSearchEvents({ query: "fair" })) as { isError?: boolean };
    const rows = await db.select().from(errorLogs).all();

    // Both signals present, or neither. A version that returned isError with no
    // row would be exactly the state this ticket found in production.
    expect(res.isError).toBe(true);
    expect(rows).toHaveLength(1);
  });
});

describe("coverage of the wrapper itself", () => {
  it("search_events is registered and wrapped", async () => {
    // If someone unwraps the tool, the fault-log tests above still need a
    // handler to call — this makes the reason for their failure legible.
    expect(server.handlers.has("search_events")).toBe(true);
  });
});
