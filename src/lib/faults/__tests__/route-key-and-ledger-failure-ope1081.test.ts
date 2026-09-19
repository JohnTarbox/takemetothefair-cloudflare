/**
 * OPE-1081 — the fault signature key embedded the raw query string, and the
 * emitter swallowed its own ledger write failures at `warn`.
 *
 * Specimen: one SQL-injection scanner against `/blog?tag=` (2026-09-12 → 09-16)
 * minted 137 `fault_signatures` rows — 80 distinct routes, keys averaging 234
 * characters, every one attack-shaped — for what is ONE defect (OPE-1045). They
 * became 70% of the triage queue and, each payload being unique, sat at count
 * 1–2 where no occurrence threshold could ever fire.
 *
 * Real SQLite, real route handler. The ledger failure is forced with a trigger,
 * so the red path runs the route's own error handling rather than a stub of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  FAULT_ROUTE_MAX,
  FAULT_SIGNATURE_MAX,
  computeSignature,
  normalizeFaultRoute,
} from "../signature";

let sqlite: Database.Database;
const logged: Array<{ level?: string; source?: string; message: string }> = [];

vi.mock("@/lib/api-auth", () => ({ internalKeyMatches: async () => true }));
vi.mock("@/lib/logger", () => ({
  logError: async (_db: unknown, o: { level?: string; source?: string; message: string }) => {
    logged.push(o);
  },
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => drizzle(sqlite, { schema }) }));

const { POST } = await import("@/app/api/internal/faults/candidates/route");

const SCHEMA_SQL = `
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'error',
    message TEXT NOT NULL, context TEXT DEFAULT '{}', url TEXT, method TEXT,
    status_code INTEGER, stack_trace TEXT, user_agent TEXT, source TEXT,
    session_id TEXT, route TEXT, digest TEXT
  );
  CREATE TABLE fault_signatures (
    signature TEXT PRIMARY KEY, route TEXT, error_class TEXT NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL,
    status TEXT NOT NULL, ope_id TEXT, filed_at INTEGER, resolved_at INTEGER,
    created_at INTEGER NOT NULL
  );
`;

const MESSAGE =
  "Failed query: select a, b from blog_posts where (status = ? and tags like ?) params: published";

/** The scanner's shape: one faulting path, a different payload every hit. */
const PAYLOADS = Array.from(
  { length: 40 },
  (_, i) => `/blog?tag=%22-2026+UNION+ALL+SELECT+%27x${i}%27%2CNULL--%22`
);

function seedBurst(routes: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const ins = sqlite.prepare(
    `INSERT INTO error_logs (id, timestamp, level, message, source, route)
     VALUES (?, ?, 'error', ?, 'server-render', ?)`
  );
  routes.forEach((r, i) => ins.run(`e${i}`, now - i, MESSAGE, r));
}

async function run() {
  const res = await POST(
    new Request("http://localhost/api/internal/faults/candidates", { method: "POST" }) as never,
    { params: Promise.resolve({}) } as never
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ledger = () =>
  sqlite.prepare("SELECT signature, route, count FROM fault_signatures").all() as Array<{
    signature: string;
    route: string | null;
    count: number;
  }>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  logged.length = 0;
});

describe("scope 1 — the route half of the key is the path", () => {
  it("a burst of 40 distinct query strings against one path mints ONE signature", async () => {
    seedBurst(PAYLOADS);
    const { status, body } = await run();

    expect(status).toBe(200);
    const rows = ledger();
    // Landmark: the rail DID write — the scan ran, grouped and proposed.
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(40);
    expect(rows[0].route).toBe("/blog");
    expect(rows[0].signature.startsWith("/blog#")).toBe(true);
    // Neither the key nor the stored route carries the payload.
    expect(rows[0].signature).not.toMatch(/UNION|SELECT|%27/);
    expect(body.ok).toBe(true);
  });

  it("the acceptance query: no ledger row has a query string or exceeds the cap", async () => {
    seedBurst([...PAYLOADS, `/events/${"a".repeat(400)}?x=1`]);
    await run();
    const offending = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM fault_signatures WHERE LENGTH(signature) > ? OR route LIKE '%?%'`
      )
      .get(FAULT_SIGNATURE_MAX) as { n: number };
    expect(offending.n).toBe(0);
    // Landmark: the query had rows to examine.
    expect(ledger().length).toBeGreaterThan(0);
  });
});

describe("scope 2 — a ledger write failure is an error and a failed run", () => {
  it("logs at error, reports ok:false and answers 500 — the cron caller's failure signal", async () => {
    seedBurst(PAYLOADS);
    sqlite.exec(`
      CREATE TRIGGER no_insert BEFORE INSERT ON fault_signatures
      BEGIN SELECT RAISE(ABORT, 'D1_ERROR: Network connection lost.'); END;
    `);

    const { status, body } = await run();

    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.ledgerWriteFailures).toBe(1);
    // The buckets still arrive whole — the scan itself ran.
    expect(Array.isArray(body.toEmit)).toBe(true);

    const failures = logged.filter((l) => l.source === "faults:candidates");
    expect(failures).toHaveLength(1);
    expect(failures[0].level).toBe("error");
    expect(failures[0].message).toMatch(/NOT a success/);
    // The heartbeat line names the failure count, so the run record says it too.
    const beat = logged.find((l) => l.source === "mcp:fault-signatures-emit");
    expect(beat?.message).toMatch(/ledgerWriteFailures=1/);
  });

  it("a transient failure that succeeds on retry is NOT a failure", async () => {
    seedBurst(PAYLOADS);
    // The FIRST insert into the ledger throws; the retry goes through. A
    // trigger cannot express "once" — RAISE(ABORT) rolls back its own counter.
    const realPrepare = sqlite.prepare.bind(sqlite);
    let attempts = 0;
    sqlite.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (!/insert into "fault_signatures"/i.test(sql)) return stmt;
      attempts += 1;
      if (attempts > 1) return stmt;
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === "run" || prop === "all" || prop === "get") {
            return () => {
              throw new Error("D1_ERROR: Network connection lost.");
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }) as typeof sqlite.prepare;

    const { status, body } = await run();
    // Landmark: the failure really fired, so the green below is the retry.
    expect(attempts).toBe(2);
    expect(status).toBe(200);
    expect(body.ledgerWriteFailures).toBe(0);
    expect(ledger()).toHaveLength(1);
    expect(logged.filter((l) => l.source === "faults:candidates")).toHaveLength(0);
  });
});

describe("normalizeFaultRoute / computeSignature", () => {
  it("drops search and fragment, keeps the path", () => {
    expect(normalizeFaultRoute("/blog?tag=x")).toBe("/blog");
    expect(normalizeFaultRoute("/events/fair#section")).toBe("/events/fair");
    expect(normalizeFaultRoute("/events/fair")).toBe("/events/fair");
    expect(normalizeFaultRoute(null)).toBeNull();
  });

  it("passes server-side source keys through unchanged", () => {
    expect(normalizeFaultRoute("app/events/page.tsx:getEvents")).toBe(
      "app/events/page.tsx:getEvents"
    );
    expect(normalizeFaultRoute("mcp:workflow:recommendations-scan")).toBe(
      "mcp:workflow:recommendations-scan"
    );
  });

  it("computeSignature normalizes on its own — the client-error ingest dedup calls it directly", () => {
    // `src/app/api/client-errors/route.ts` keys its dedup on computeSignature
    // with a client-supplied pathname and no normalizeFaultRoute of its own.
    const bare = computeSignature({ route: "/blog", message: MESSAGE, digest: null });
    for (const p of PAYLOADS.slice(0, 5)) {
      expect(computeSignature({ route: p, message: MESSAGE, digest: null })).toBe(bare);
    }
  });

  it("bounds a long path, and two long paths with a shared prefix stay distinct", () => {
    const a = normalizeFaultRoute(`/x/${"a".repeat(300)}1`)!;
    const b = normalizeFaultRoute(`/x/${"a".repeat(300)}2`)!;
    expect(a.length).toBeLessThanOrEqual(FAULT_ROUTE_MAX);
    expect(a).not.toBe(b);
  });

  it("bounds the whole key, and leaves every realistic key byte-identical", () => {
    const long = computeSignature({ route: "/r", message: "x ".repeat(600), digest: null });
    expect(long.length).toBeLessThanOrEqual(FAULT_SIGNATURE_MAX);
    // The longest legitimate key on prod was 491 chars; nothing under the cap
    // may be re-keyed, or a filed/done row loses its regression match.
    const msg = "fetch failed (app/vendors/[slug]/page.tsx:getvendor) cause: timeout";
    expect(computeSignature({ route: "/vendors/lainverse", message: msg, digest: null })).toBe(
      `/vendors/lainverse#${msg.toLowerCase()}`
    );
  });
});
