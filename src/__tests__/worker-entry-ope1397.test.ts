// @vitest-environment node
/**
 * OPE-1397 (fix) — anonymous RSC hits on /admin* are recorded by the Worker
 * entry, which sees the raw request before Next strips the flight headers.
 *
 * Runs `withAdminRscSampler` around a stand-in for OpenNext's handler against
 * an in-memory sqlite built from the real migrations, and pins the wiring that
 * makes it run in prod: wrangler.toml `main` → worker.mjs → the wrapper.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("drizzle-orm/d1", async () => {
  const sqlite = await import("drizzle-orm/better-sqlite3");
  return { drizzle: (client: Database.Database) => sqlite.drizzle(client) };
});

import { withAdminRscSampler, sampleAnonymousAdminRsc } from "../worker/admin-rsc-sampler";

const ROOT = join(__dirname, "..", "..");
const ORIGIN = "https://meetmeatthefair.com";

let db: Database.Database;
let pending: Promise<unknown>[];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
  passThroughOnException() {},
};

beforeEach(() => {
  db = new Database(":memory:");
  for (const f of ["0130_request_samples.sql", "0373_ope1397_request_samples_kind.sql"]) {
    db.exec(readFileSync(join(ROOT, "drizzle", f), "utf8"));
  }
  pending = [];
});

const rows = () =>
  db.prepare(`SELECT * FROM request_samples ORDER BY path`).all() as Record<string, unknown>[];

function makeRequest(path: string, headers: Record<string, string>, cf?: object): Request {
  const req = new Request(`${ORIGIN}${path}`, { headers });
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  return req;
}

async function hit(path: string, headers: Record<string, string>, cf?: object) {
  const inner = vi.fn(
    async (_req: Request, _env: unknown, _ctx: unknown) => new Response("next", { status: 307 })
  );
  const worker = withAdminRscSampler({ fetch: inner });
  const req = makeRequest(path, headers, cf);
  const res = await worker.fetch(req, { DB: db } as never, ctx);
  await Promise.all(pending);
  return { res, inner, req };
}

describe("Worker entry — anonymous RSC hits on /admin (OPE-1397)", () => {
  it("records RSC + no session cookie: path/country/ASN/timestamp only, response untouched", async () => {
    const { res, inner, req } = await hit(
      "/admin/claims",
      {
        rsc: "1",
        "user-agent": "curl/8",
        "cf-connecting-ip": "203.0.113.9",
        "cf-ipcountry": "CA",
        referer: "https://evil.example/",
      },
      { asn: 64500, country: "US", asOrganization: "EXAMPLE-NET" }
    );
    // Next got the SAME request (headers intact) and its response is returned as-is.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][0]).toBe(req);
    expect(res.status).toBe(307);
    expect(await res.text()).toBe("next");

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: "admin_rsc_anon",
      path: "/admin/claims",
      asn: 64500,
      country: "CA",
      user_agent: null,
      ip: null,
      as_organization: null,
      referer: null,
      ray: null,
      method: null,
    });
    expect(typeof r[0].timestamp).toBe("number");
  });

  it("records the bare /admin path with only Next-Router-State-Tree; country falls back to request.cf", async () => {
    await hit(
      "/admin",
      { "next-router-state-tree": "%5B%22%22%5D" },
      { asn: 13335, country: "DE" }
    );
    expect(rows().map((r) => [r.path, r.country, r.asn])).toEqual([["/admin", "DE", 13335]]);
  });

  it("does NOT record a signed-in admin's RSC navigation", async () => {
    await hit("/admin/claims", { rsc: "1", cookie: "__Secure-authjs.session-token=abc" });
    expect(rows()).toHaveLength(0);
  });

  it("does NOT record a plain signed-out GET of /admin, or RSC outside /admin", async () => {
    await hit("/admin/claims", {});
    await hit("/events/some-fair", { rsc: "1" });
    await hit("/api/admin/claims", { rsc: "1" });
    expect(rows()).toHaveLength(0);
  });

  it("never throws or blocks: no DB binding, or a broken DB, still serves the response", async () => {
    const inner = vi.fn(async (_req: Request, _env: unknown, _ctx: unknown) => new Response("ok"));
    const worker = withAdminRscSampler({ fetch: inner });
    const req = makeRequest("/admin/claims", { rsc: "1" });
    await expect(worker.fetch(req, undefined as never, ctx)).resolves.toBeInstanceOf(Response);
    await expect(worker.fetch(req, {} as never, ctx)).resolves.toBeInstanceOf(Response);
    db.close(); // writes now throw inside writeRequestSample — swallowed there
    await expect(worker.fetch(req, { DB: db } as never, ctx)).resolves.toBeInstanceOf(Response);
    await Promise.all(pending);
    // A throwing waitUntil (sampler's own failure) is swallowed too.
    expect(() =>
      sampleAnonymousAdminRsc(req, { DB: db } as never, {
        waitUntil() {
          throw new Error("boom");
        },
      })
    ).not.toThrow();
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("keeps the wrapped handler's other members (e.g. queue/scheduled) intact", () => {
    const other = () => undefined;
    const worker = withAdminRscSampler({ fetch: async () => new Response(), scheduled: other });
    expect(worker.scheduled).toBe(other);
  });
});

describe("Worker entry wiring — the sampler actually runs in prod (OPE-1397)", () => {
  it("wrangler.toml main is worker.mjs (not OpenNext's raw .open-next/worker.js)", () => {
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    const mains = [...toml.matchAll(/^main\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
    expect(mains).toEqual(["worker.mjs"]);
  });

  it("worker.mjs wraps OpenNext's default export and re-exports its Durable Object classes", () => {
    const entry = readFileSync(join(ROOT, "worker.mjs"), "utf8");
    expect(entry).toMatch(/^import (\w+) from "\.\/\.open-next\/worker\.js";$/m);
    const name = entry.match(/^import (\w+) from "\.\/\.open-next\/worker\.js";$/m)![1];
    expect(entry).toMatch(
      /^import \{ withAdminRscSampler \} from "\.\/src\/worker\/admin-rsc-sampler";$/m
    );
    expect(entry).toContain(`export default withAdminRscSampler(${name});`);
    // NEXT_CACHE_DO_QUEUE binds class DOQueueHandler from THIS script; without
    // the re-export the deploy fails.
    expect(entry).toMatch(/^export \* from "\.\/\.open-next\/worker\.js";$/m);
  });
});
