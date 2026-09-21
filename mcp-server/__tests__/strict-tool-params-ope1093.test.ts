/**
 * OPE-1093 — an unknown tool parameter must not be silently discarded.
 *
 * Every tool here registers with `server.tool(name, description, rawShape, cb)`.
 * The SDK turns a raw shape into `z.object(shape)`, and Zod's default is to
 * STRIP unknown keys before the handler runs. So OPE-1090's caller passed five
 * parameters that did not exist on that tool, got `created: true`, and a public
 * vendor row with five NULLs — no error, no warning, nothing to read.
 *
 * `create_vendor` is the first tool moved to `registerTool`, which accepts a
 * fully-built schema so `.strict()` survives to validation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { vendors } from "../src/schema.js";
import { eq } from "drizzle-orm";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db as never, ADMIN_AUTH);
});

const exists = (name: string) =>
  db.select().from(vendors).where(eq(vendors.businessName, name)).all().length > 0;

describe("OPE-1093 — an unknown parameter is rejected, not discarded", () => {
  it("ACCEPTANCE: the call fails and names the offending parameter", async () => {
    const res = (await server.invoke("create_vendor", {
      business_name: "Typo Crafts",
      citty: "Portland", // the typo
    })) as { isError?: boolean; content: { text?: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("citty");
  });

  it("…and NOTHING is written — the half-empty public row is never created", async () => {
    await server.invoke("create_vendor", { business_name: "Typo Crafts", citty: "Portland" });

    // This is the half that matters. A warning-only design would leave a public
    // vendor page here with no city and no state, which is the harm OPE-1090
    // measured: invisible to every by-state browse, reported as success.
    expect(exists("Typo Crafts")).toBe(false);
  });

  it("reproduces OPE-1090's exact call shape — five unknown params, five NULLs", async () => {
    // Before this change these five were stripped and the row was created.
    // `contact_name` and `social_links` are now declared (OPE-1090), so the
    // still-unknown ones are the genuinely misspelt kind.
    const res = (await server.invoke("create_vendor", {
      business_name: "Shannon's Kustom Shoes and Shirts",
      vendorType: "Crafts", // camelCase — the column name, not the param
      contactName: "Shannon",
      socialLinks: "{}",
    })) as { isError?: boolean };

    expect(res.isError).toBe(true);
    expect(exists("Shannon's Kustom Shoes and Shirts")).toBe(false);
  });

  it("a correct call is unaffected — strictness rejects the unknown, not the unusual", async () => {
    const res = (await server.invoke("create_vendor", {
      business_name: "Good Call Co",
      city: "Portland",
      state: "ME",
      vendor_type: "Crafts",
      contact_name: "Sam",
      social_links: '{"facebook":"https://facebook.com/x"}',
    })) as { isError?: boolean };

    expect(res.isError).toBeUndefined();
    expect(exists("Good Call Co")).toBe(true);
  });

  it("the deprecated aliases still pass strict validation — they are DECLARED, not unknown", async () => {
    // OPE-1090 kept `location`/`type` so existing callers do not break. Strict
    // mode must not undo that: they are declared parameters.
    const res = (await server.invoke("create_vendor", {
      business_name: "Legacy Vocab Co",
      location: "Dublin, NH",
      type: "Food & Beverage",
    })) as { isError?: boolean };

    expect(res.isError).toBeUndefined();
    expect(exists("Legacy Vocab Co")).toBe(true);
  });
});

describe("OPE-1093 — scope 2: the tool still lands in the registry tools/list reads", () => {
  it("registerTool puts create_vendor in a REAL McpServer's registry", () => {
    // The dual-registration guard checks which REGISTRARS appear on both paths,
    // not which tools land — so it would stay green even if `registerTool` put
    // nothing in the registry. Both paths construct a real `McpServer`
    // (index.ts:242 OAuth, index.ts:517 legacy `mmatf_`), so proving it against
    // the real class proves it for both.
    const { db: realDb } = createTestDb();
    const real = new McpServer({ name: "test", version: "0.0.0" });
    registerAdminTools(real, realDb as never, ADMIN_AUTH);

    const registered = Object.keys(
      (real as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}
    );

    expect(registered).toContain("create_vendor");
    // A landmark: a neighbouring `server.tool` registration is still there too,
    // so this asserts coexistence rather than "some tools exist".
    expect(registered).toContain("update_vendor");
  });
});

describe("OPE-1093 — scope 4: what the client is TOLD, before it calls", () => {
  it("a strict schema advertises additionalProperties:false; a raw shape does not", () => {
    // `tools/list` runs the registered schema through
    // normalizeObjectSchema → toJsonSchemaCompat (sdk mcp.js:75-83), so this is
    // the schema an agent client actually receives.
    //
    // This matters more than the rejection itself: a client that honours the
    // advertised schema stops sending the unknown key in the first place, so
    // strictness mostly prevents the mistake rather than punishing it. The
    // error is the backstop for clients that do not look.
    const strict = toJsonSchemaCompat(
      normalizeObjectSchema(z.object({ business_name: z.string() }).strict() as never) as never,
      { strictUnions: true, pipeStrategy: "input" } as never
    ) as Record<string, unknown>;
    expect(strict.additionalProperties).toBe(false);

    const rawShape = toJsonSchemaCompat(
      normalizeObjectSchema({ business_name: z.string() } as never) as never,
      { strictUnions: true, pipeStrategy: "input" } as never
    ) as Record<string, unknown>;
    // Today's 241 other tools: nothing tells the client that extra keys are
    // not welcome, which is why sending them looks reasonable.
    expect(rawShape.additionalProperties).not.toBe(false);
  });
});
