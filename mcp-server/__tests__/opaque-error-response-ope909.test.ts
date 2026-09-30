/**
 * OPE-909 item 3 — a failing MCP Worker endpoint returns a code and a request
 * id; the original message is in error_logs under that id, not in the body.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb } from "./setup-db.js";
import { errorLogs } from "../src/schema.js";
import { opaqueErrorResponse } from "../src/error-response.js";

const SECRET_DETAIL =
  "binding SCHEMA_ORG_SYNC: instance abc not found at https://internal.example/x";

describe("OPE-909 — opaqueErrorResponse", () => {
  it("ACCEPTANCE: the body has a code and request id, no message; the log row for that id has the message", async () => {
    const { db } = createTestDb();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("https://mcp.example/api/admin/workflows/x", {
      headers: { "cf-ray": "8f00ray-ORD" },
    });

    const res = await opaqueErrorResponse(db as never, request, {
      source: "mcp:workflows-api",
      message: "schema-org-sync status lookup failed",
      err: new Error(SECRET_DETAIL),
      code: "workflow_not_found",
      status: 404,
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "workflow_not_found", request_id: "8f00ray-ORD" });
    expect(text).not.toContain("internal.example");

    const [row] = await db.select().from(errorLogs);
    expect(row.message).toContain(SECRET_DETAIL);
    expect(row.message).toContain("request_id=8f00ray-ORD");
    expect(JSON.parse(row.context ?? "{}")).toMatchObject({ requestId: "8f00ray-ORD" });
  });

  it("generates a request id when there is no cf-ray", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await opaqueErrorResponse(null, new Request("https://mcp.example/"), {
      source: "s",
      message: "m",
      err: new Error("x"),
      code: "internal_error",
      status: 500,
    });
    expect((await res.json()).request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("no MCP Worker response body carries err.message any more (the three sites the review named)", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    // Landmark: the helper really is what those paths call now.
    expect(src.match(/opaqueErrorResponse\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/message:\s*err instanceof Error \? err\.message/);
    expect(src).not.toMatch(/error:\s*err\?\.message/);
  });
});
