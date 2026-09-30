/**
 * OPE-593 (09-23 bounce) — the fuzzy ORDER BY scoring term was not capped.
 *
 * MAX_FUZZY_TOKENS = 24 capped the WHERE candidate gate, but the ORDER BY
 * score bound one `instr` parameter per token for EVERY token. Prod, via the
 * MCP tool: 32 tokens returned, 48 and 81 failed — 8 status + 48 WHERE +
 * 3 whole-query + 48 ORDER BY + 1 limit = 108 bound parameters, over D1's 100.
 *
 * better-sqlite3 allows 32766, so "call it and expect no throw" passes WITH the
 * bug. The guard asserts the shape D1 enforces: no statement binds > 100.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import type Database from "better-sqlite3";
import { registerPublicTools } from "../src/tools/public.js";
import { promoters } from "../src/schema.js";
import { D1_MAX_BIND_PARAMS } from "@takemetothefair/utils";

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;
let prepared: string[];

beforeEach(() => {
  ({ db, raw } = createTestDb());
  prepared = [];
  const orig = raw.prepare.bind(raw);
  (raw as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
    prepared.push(s);
    return orig(s);
  };
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();
});

const blurb = (n: number) => Array.from({ length: n }, (_, i) => `tokenword${i}`).join(" ");
const binds = (s: string) => (s.match(/\?/g) ?? []).length;

describe("OPE-593 — a long fuzzy query stays under D1's 100 bound parameters", () => {
  for (const n of [32, 48, 81]) {
    it(`${n} tokens: every statement binds <= ${D1_MAX_BIND_PARAMS}`, async () => {
      await server.invoke("search_events", { query: blurb(n), fuzzy: true });
      const main = prepared.filter((s) => /from "events"/i.test(s));
      expect(main.length).toBeGreaterThan(0); // the guard found the statement
      const worst = Math.max(...main.map(binds));
      expect(worst).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    });
  }
});
