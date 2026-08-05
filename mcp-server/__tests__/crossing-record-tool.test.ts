import { describe, it, expect, vi } from "vitest";
import { registerCrossingRecordTools } from "../src/tools/admin-crossing-record.js";

/** Minimal McpServer stand-in that captures what gets registered. */
function fakeServer() {
  const tools: Record<string, { schema: unknown; handler: (args: never) => Promise<unknown> }> = {};
  return {
    tools,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, _desc: string, schema: any, handler: any) => {
      tools[name] = { schema, handler };
    },
  };
}

function envWithBinding(response: Response) {
  return {
    INTERNAL_API_KEY: "k",
    MAIN_APP: { fetch: vi.fn(async () => response) },
  };
}

describe("record_crossing (OPE-326)", () => {
  it("is admin-only — a non-admin session never sees the tool", () => {
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCrossingRecordTools(server as any, { role: "VENDOR" } as any, {});
    expect(server.tools.record_crossing).toBeUndefined();
  });

  it("registers for an admin session", () => {
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCrossingRecordTools(server as any, { role: "ADMIN" } as any, {});
    expect(server.tools.record_crossing).toBeDefined();
  });

  it("maps snake_case args to the route's camelCase body", async () => {
    // The tool's args and the route's schema use different casing. A silent
    // mismatch here would 400 on every call, so it is worth pinning.
    const env = envWithBinding(
      new Response(JSON.stringify({ ok: true, id: "x" }), { status: 200 })
    );
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCrossingRecordTools(server as any, { role: "ADMIN" } as any, env as any);

    await server.tools.record_crossing.handler({
      source_ref: "issue:OPE-326",
      crossing_type: "review_to_rework",
      destination_ref: "lane:developer-claude-code",
      actor: "agent",
    } as never);

    const req = env.MAIN_APP.fetch.mock.calls[0][0] as Request;
    expect(new URL(req.url).pathname).toBe("/api/internal/crossings/record");
    expect(await req.json()).toMatchObject({
      sourceRef: "issue:OPE-326",
      crossingType: "review_to_rework",
      destinationRef: "lane:developer-claude-code",
      actor: "agent",
    });
  });

  it("reports a failed write as an error instead of swallowing it", async () => {
    // The in-pipeline ledger helper never throws, because a ledger must not
    // break what it observes. Here the caller's ONLY purpose is to ledger, so
    // "recorded" when nothing was written would be the worst answer.
    const env = envWithBinding(
      new Response(JSON.stringify({ ok: false, error: "insert_failed" }), { status: 500 })
    );
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCrossingRecordTools(server as any, { role: "ADMIN" } as any, env as any);

    const res = (await server.tools.record_crossing.handler({
      source_ref: "issue:OPE-326",
      crossing_type: "review_to_rework",
    } as never)) as { isError?: boolean };

    expect(res.isError).toBe(true);
  });

  it("surfaces a transport failure rather than reporting success", async () => {
    const env = {
      INTERNAL_API_KEY: undefined,
      MAIN_APP: undefined,
    };
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCrossingRecordTools(server as any, { role: "ADMIN" } as any, env as any);

    const res = (await server.tools.record_crossing.handler({
      source_ref: "issue:OPE-326",
      crossing_type: "review_to_rework",
    } as never)) as { isError?: boolean };

    expect(res.isError).toBe(true);
  });
});
