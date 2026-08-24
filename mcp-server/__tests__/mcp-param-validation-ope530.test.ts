/**
 * OPE-530 — the test harness ran the handler but never the schema.
 *
 * `CapturingMcpServer.tool()` took `_schema: unknown` and dropped it, and
 * `invoke()` handed raw params straight to the handler. So across ~200 live
 * tools, every `.url()`, `.regex()`, `.min()`, `.max()`, `.enum()` and
 * `.transform()` was unpinned: deleting a constraint produced no failure
 * anywhere, and handlers were being exercised with input the real MCP
 * boundary would have refused.
 *
 * These tests pin the capability itself. Two of them are the cases removed
 * from OPE-526's PR, which failed there against the tool and were deleted
 * rather than left asserting the harness instead of the schema.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { users } from "../src/schema.js";

const AUTH = { userId: "u-submitter", role: "USER" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-submitter", email: "submitter@test", role: "USER" }).run();
  registerVendorTools(server as never, db, AUTH, undefined);
});

async function invoke(tool: string, args: Record<string, unknown>) {
  return (await server.invoke(tool, args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
}

describe("a real tool's constraints are now enforced", () => {
  it("rejects a non-URL application_url", async () => {
    // Removed from OPE-526 because it failed against a harness that never ran
    // `.url()`. The constraint was always real at the MCP boundary.
    const r = await invoke("suggest_event", {
      name: "Kingfield Craft Fair",
      start_date: "2026-09-15",
      application_url: "email us",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("application_url");
  });

  it("rejects a prose application_deadline", async () => {
    // `.regex(/^\d{4}-\d{2}-\d{2}$/)`. "August 1st" is the shape a model
    // actually emits, which is why the constraint exists.
    const r = await invoke("suggest_event", {
      name: "Kingfield Craft Fair",
      start_date: "2026-09-15",
      application_deadline: "August 1st",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("application_deadline");
  });

  it("accepts the well-formed equivalents — these are the controls", async () => {
    // Without these, a harness that rejected EVERYTHING would look correct.
    const r = await invoke("suggest_event", {
      name: "Kingfield Craft Fair",
      start_date: "2026-09-15",
      application_url: "https://kingfieldcraftfair.org/apply",
      application_deadline: "2026-08-01",
    });
    expect(r.isError).toBeFalsy();
  });

  it("reports the offending field by name, not just that something was wrong", async () => {
    const r = await invoke("suggest_event", { start_date: "2026-09-15" }); // no name
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("name");
  });
});

describe("the harness itself", () => {
  // A synthetic tool, so these assert the mechanism rather than any one tool's
  // current schema — which would otherwise make them break for unrelated reasons.
  function register(shape: Record<string, z.ZodTypeAny>, s = server) {
    let seen: Record<string, unknown> | null = null;
    (s as unknown as CapturingMcpServer).tool(
      "probe",
      "synthetic",
      shape,
      async (params: Record<string, unknown>) => {
        seen = params;
        return { content: [{ type: "text", text: "ok" }] };
      }
    );
    return () => seen;
  }

  it("applies transforms before the handler sees the value", async () => {
    // The half of this that matters most in practice. House convention puts
    // `decodeHtmlEntities` / `sanitizeProse` at the schema layer, so a handler
    // receiving RAW params was never seeing what production hands it — and a
    // dropped transform would have gone unnoticed while dedup and slug
    // generation silently started seeing entity-encoded text again.
    const seen = register({ title: z.string().transform((v) => v.trim().toUpperCase()) });
    await server.invoke("probe", { title: "  earth expo  " });
    expect(seen()).toEqual({ title: "EARTH EXPO" });
  });

  it("returns an MCP error result rather than throwing", async () => {
    // Returned, not thrown: the live surface answers a bad argument with an
    // error RESULT, and a test should be able to read the message.
    register({ n: z.number() });
    const r = (await server.invoke("probe", { n: "not a number" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Invalid arguments for probe/);
  });

  it("still refuses an unregistered tool loudly", async () => {
    expect(() => server.invoke("nope", {})).toThrow(/not registered/i);
  });

  it("keeps `handlers` usable as a plain name→handler map", async () => {
    // Existing tests call `.has()` and `.size` on it; the shapes live apart.
    register({ n: z.number() });
    expect(server.handlers.has("probe")).toBe(true);
    expect(server.schemas.has("probe")).toBe(true);
  });

  it("can be opted out of, and says so at the call site", async () => {
    // The escape hatch for characterising pre-existing behaviour. Default is
    // ON — an opt-in default would have left the harness silently permissive,
    // which is the state this whole ticket is about.
    const permissive = new CapturingMcpServer({ validate: false });
    const seen = register({ n: z.number() }, permissive);
    await permissive.invoke("probe", { n: "not a number" });
    expect(seen()).toEqual({ n: "not a number" });
  });
});
