/**
 * OPE-1132 batch 1 — a CREATE tool rejects a parameter it does not declare.
 *
 * Driven through the real SDK end to end: a real McpServer wrapped by
 * applyToolParamPolicy, every registrar index.ts calls, and a Client over an
 * InMemoryTransport. So `tools/list` and `tools/call` below are the SDK's own
 * request handlers, reading the same RegisteredTool the wrap tightened — not a
 * harness re-implementation of them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  applyToolParamPolicy,
  paramPolicyFor,
  REJECT_UNKNOWN_PARAMS,
  withIgnoredParams,
} from "../src/tool-param-policy.js";
import { z } from "zod";
import { promoters } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(here, "../src/index.ts"), "utf8");

// A vendorId too, or registerVendorTools returns before apply_to_event.
const AUTH = { userId: "u-admin", role: "ADMIN" as const, vendorId: "v-1", email: "a@b.test" };

/**
 * Every register*() index.ts imports from ./tools, called with the argument
 * list index.ts itself uses. Parsed from index.ts rather than hand-listed, so
 * a registrar added there is covered here without anyone remembering to.
 */
async function registerEverything(server: McpServer, db: TestDb): Promise<string[]> {
  const imports = [...INDEX_SRC.matchAll(/^import \{([^}]*)\} from "(\.\/tools\/[^"]+)";/gm)];
  const argLists = new Map<string, string[]>();
  for (const m of INDEX_SRC.matchAll(/\b(register\w+)\(([^)]*)\);/g)) {
    if (!argLists.has(m[1]))
      argLists.set(
        m[1],
        m[2].split(",").map((a) => a.trim())
      );
  }
  const env = {} as never;
  const byName: Record<string, unknown> = { server, db, auth: AUTH, env };
  const called: string[] = [];
  for (const [, names, path] of imports) {
    const mod = (await import(resolve(here, "../src", path.replace(/^\.\//, "")))) as Record<
      string,
      (...a: unknown[]) => void
    >;
    for (const name of names.split(",").map((n) => n.trim())) {
      const args = argLists.get(name);
      if (!name.startsWith("register") || !args) continue;
      mod[name](...args.map((a) => byName[a.replace(/^this\./, "")]));
      called.push(name);
    }
  }
  return called;
}

let db: TestDb;
let client: Client;
let listed: Map<string, { additionalProperties?: unknown }>;

beforeAll(async () => {
  ({ db } = createTestDb());
  const server = applyToolParamPolicy(new McpServer({ name: "t", version: "0" }));
  const called = await registerEverything(server, db);
  expect(called.length).toBeGreaterThan(30);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  listed = new Map(tools.map((t) => [t.name, t.inputSchema as { additionalProperties?: unknown }]));
});

type CallResult = { isError?: boolean; content: { type: string; text?: string }[] };
const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallResult>;
const promoterNamed = (name: string) =>
  db.select().from(promoters).where(eq(promoters.companyName, name)).all();

describe("OPE-1132 — the set names real tools", () => {
  // A misspelled entry would leave the real tool permissive and nothing would
  // say so. That is the defect this ticket removes, so the set cannot have it.
  it.each([...REJECT_UNKNOWN_PARAMS])("%s is registered", (name) => {
    expect(listed.has(name)).toBe(true);
  });
});

describe("OPE-1132 — tools/list advertises the constraint", () => {
  it.each([...REJECT_UNKNOWN_PARAMS])("%s: additionalProperties false", (name) => {
    expect(listed.get(name)?.additionalProperties).toBe(false);
  });

  it("a WARN tool does not advertise the constraint (update_promoter accepts, then names, extras)", () => {
    expect(listed.get("update_promoter")?.additionalProperties).not.toBe(false);
  });
});

describe("OPE-1132 — tools/call refuses the unknown key and writes nothing", () => {
  it("ACCEPTANCE: create_promoter with a typo'd key fails, names the key, and inserts no row", async () => {
    const res = await call("create_promoter", { name: "Typo Fair Co", citty: "Portland" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("citty");
    expect(promoterNamed("Typo Fair Co")).toHaveLength(0);
  });

  it("CONTROL: the same call without the stray key creates the row", async () => {
    const res = await call("create_promoter", { name: "Clean Fair Co", city: "Portland" });
    expect(res.isError).toBeFalsy();
    expect(promoterNamed("Clean Fair Co")).toHaveLength(1);
  });

  it("the specimen from the caller scan: discontinuous_dates on create_event_day is refused, not dropped", async () => {
    const res = await call("create_event_day", {
      event_id: "e-none",
      date: "2026-10-01",
      discontinuous_dates: 1,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("discontinuous_dates");
  });
});

describe("OPE-1132 — index.ts applies the policy on BOTH transports", () => {
  // Anchored on the call syntax around each construction, not the bare symbol,
  // which would also match the import line.
  it("the OAuth Durable Object's server", () => {
    expect(INDEX_SRC).toMatch(/server = applyToolParamPolicy\(\s*new McpServer\(/);
  });
  it("the legacy mmatf_ token path's server", () => {
    expect(INDEX_SRC).toMatch(
      /const server = applyToolParamPolicy\(new McpServer\(\{ name: "MeetMeAtTheFair"/
    );
  });
  it("no McpServer is constructed without it", () => {
    const bare = INDEX_SRC.match(/new McpServer\(/g) ?? [];
    const wrapped = INDEX_SRC.match(/applyToolParamPolicy\(\s*new McpServer\(/g) ?? [];
    expect(bare.length).toBe(wrapped.length);
  });
});

// ── batch 2: every tool that is neither a listed create nor a read WARNS ──────

describe("OPE-1132 batch 2 — the policy split over every registered tool", () => {
  it("creates reject; every other registered tool — reads included — warns", () => {
    const by: Record<string, string[]> = { reject: [], warn: [] };
    for (const name of listed.keys()) by[paramPolicyFor(name)].push(name);
    // create_vendor is registerTool + its own .strict(), not the wrap's.
    expect(by.reject.sort()).toEqual([...REJECT_UNKNOWN_PARAMS].sort());
    expect(by.warn.length + by.reject.length).toBe(listed.size);
    expect(by.warn).toEqual(
      expect.arrayContaining([
        "update_promoter",
        "merge_events",
        "search_promoters",
        "get_event_details",
      ])
    );
  });
});

describe("OPE-1132 batch 2 — a WARN tool applies the known fields and names the unknown", () => {
  it("ACCEPTANCE: update_promoter with a typo'd key updates the real field and reports the typo", async () => {
    await call("create_promoter", { name: "Warn Fair Co" });
    const [row] = promoterNamed("Warn Fair Co");
    const res = await call("update_promoter", {
      promoter_id: row.id,
      city: "Bangor",
      stat: "ME", // the typo — `state` was meant
    });
    expect(res.isError).toBeFalsy();
    expect(promoterNamed("Warn Fair Co")[0].city).toBe("Bangor");
    const body = JSON.parse(res.content[0].text ?? "{}");
    expect(body.warnings.ignored_params).toEqual(["stat"]);
  });

  it("CONTROL: the same update without a stray key carries no ignored_params", async () => {
    const [row] = promoterNamed("Warn Fair Co");
    const res = await call("update_promoter", { promoter_id: row.id, city: "Augusta" });
    expect(res.isError).toBeFalsy();
    expect(res.content.map((c) => c.text ?? "").join("")).not.toContain("ignored_params");
  });

  it("batch 3: a READ tool names a stray key too, and still answers", async () => {
    const res = await call("search_promoters", { query: "Fair", colour: "red" });
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("ignored_params");
    expect(text).toContain("colour");
  });
});

describe("OPE-1132 batch 2 — the handler never sees the extra key", () => {
  // The default strip guaranteed this; a loose schema alone would break it and
  // hand `...params` spreads a key nobody declared. Pinned on a probe tool whose
  // handler records exactly what it was given.
  it("args reaching the handler are the declared keys only", async () => {
    const server = applyToolParamPolicy(new McpServer({ name: "p", version: "0" }));
    const seen: Record<string, unknown>[] = [];
    server.tool("update_probe", "probe", { a: z.string() }, async (args) => {
      seen.push(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
    });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await server.connect(x);
    const c = new Client({ name: "c", version: "0" });
    await c.connect(y);
    const res = (await c.callTool({
      name: "update_probe",
      arguments: { a: "1", b: "2" },
    })) as CallResult;
    expect(seen).toEqual([{ a: "1" }]);
    expect(JSON.parse(res.content[0].text ?? "{}")).toEqual({
      ok: true,
      warnings: { ignored_params: ["b"] },
    });
  });
});

describe("OPE-1132 batch 2 — withIgnoredParams respects a tool's own warnings shape", () => {
  const wrap = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
  const out = (r: unknown) => (r as CallResult).content;

  it("no warnings → warnings.ignored_params", () => {
    expect(JSON.parse(out(withIgnoredParams(wrap({ ok: 1 }), ["x"]))[0].text!)).toEqual({
      ok: 1,
      warnings: { ignored_params: ["x"] },
    });
  });
  it("an object of warnings → merged, the tool's own keys kept", () => {
    const r = withIgnoredParams(wrap({ warnings: { possible_duplicates: [1] } }), ["x"]);
    expect(JSON.parse(out(r)[0].text!).warnings).toEqual({
      possible_duplicates: [1],
      ignored_params: ["x"],
    });
  });
  it("an array of warnings → one string appended, the array kept", () => {
    const r = withIgnoredParams(wrap({ warnings: ["w1"] }), ["x", "y"]);
    const w = JSON.parse(out(r)[0].text!).warnings as string[];
    expect(w[0]).toBe("w1");
    expect(w[1]).toMatch(/^ignored_params: x, y/);
  });
  it("plain-text output → a second item, the original text untouched", () => {
    const r = withIgnoredParams({ content: [{ type: "text", text: "Updated." }] }, ["x"]);
    expect(out(r)[0].text).toBe("Updated.");
    expect(JSON.parse(out(r)[1].text!)).toEqual({ warnings: { ignored_params: ["x"] } });
  });
  it("an error result still carries the warning (the caller should learn both)", () => {
    const r = withIgnoredParams({ ...wrap({ error: "nope" }), isError: true }, ["x"]) as CallResult;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text!).warnings.ignored_params).toEqual(["x"]);
  });
});
