// @vitest-environment node
/**
 * OPE-1397 regression guard — nothing behind Next may try to read the RSC
 * flight headers.
 *
 * The first anonymous-admin-RSC sampler lived in src/middleware.ts and wrote 0
 * rows in prod: Next deletes every FLIGHT_HEADER (RSC, Next-Router-State-Tree,
 * Next-Router-Prefetch, …) before middleware runs
 * (node_modules/next/dist/server/web/adapter.js:137-146) AND before
 * `headers()` in render (node_modules/next/dist/server/async-storage/
 * request-store.js:33-38). Its unit test called `middleware()` directly,
 * skipping the adapter, so it was green while the code was dead.
 *
 * 1. Proves the stripping against the REAL adapter (so if a Next upgrade stops
 *    stripping, this goes red and the reasoning can be revisited).
 * 2. Fails if any src file other than the predicate's own module (and a
 *    future custom-Worker-entry sampler at src/worker/admin-rsc-sampler.ts,
 *    the only place the raw headers are visible) reads a flight header or
 *    calls isAnonymousAdminRscRequest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { FLIGHT_HEADERS } from "next/dist/client/components/app-router-headers";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** The only files allowed to read flight headers / call the predicate. */
const ALLOWED = new Set(["src/lib/request-sampling.ts", "src/worker/admin-rsc-sampler.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("OPE-1397 — Next strips flight headers before user code", () => {
  it("the real middleware adapter hands middleware a request WITHOUT RSC / Next-Router-State-Tree", async () => {
    // The edge runtime provides this global; Node needs it set before Next's
    // async-storage modules load, hence the dynamic import.
    (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
    const { adapter } = await import("next/dist/server/web/adapter");
    const seen: Record<string, string | null> = {};
    await adapter({
      handler: async (req: Request) => {
        for (const h of ["rsc", "next-router-state-tree", "next-router-prefetch", "x-probe"]) {
          seen[h] = req.headers.get(h);
        }
        return new Response(null, { status: 200 });
      },
      page: "/middleware",
      request: {
        url: "https://meetmeatthefair.com/admin/claims",
        method: "GET",
        headers: {
          rsc: "1",
          "next-router-state-tree": "%5B%22%22%5D",
          "next-router-prefetch": "1",
          "x-probe": "kept",
        },
        nextConfig: {},
      },
    } as never);
    expect(seen["x-probe"]).toBe("kept"); // the handler really ran and saw headers
    expect(seen.rsc).toBeNull();
    expect(seen["next-router-state-tree"]).toBeNull();
    expect(seen["next-router-prefetch"]).toBeNull();
  });

  it("render's headers() store strips them too (request-store.js getHeaders)", () => {
    const src = readFileSync(
      join(ROOT, "node_modules/next/dist/server/async-storage/request-store.js"),
      "utf8"
    );
    expect(src).toMatch(
      /function getHeaders\(headers\)[\s\S]{0,200}FLIGHT_HEADERS[\s\S]{0,80}\.delete\(header\)/
    );
  });
});

describe("OPE-1397 — no src file behind Next reads a flight header", () => {
  const files = walk(SRC).map((f) => ({ rel: relative(ROOT, f), text: readFileSync(f, "utf8") }));

  it("scans a real file set", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === "src/middleware.ts")).toBe(true);
  });

  it("only the Worker-entry sampler reads RSC / Next-Router-* headers", () => {
    const read = new RegExp(
      `\\.(get|has)\\(\\s*["'\`](${FLIGHT_HEADERS.map(escape).join("|")})["'\`]`,
      "i"
    );
    const offenders = files
      .filter((f) => !ALLOWED.has(f.rel) && read.test(f.text))
      .map((f) => f.rel);
    expect(
      offenders,
      "These files read a Next flight header (RSC / Next-Router-State-Tree / …). Next deletes " +
        "those before middleware (next/dist/server/web/adapter.js:137-146) and before headers() " +
        "in render (next/dist/server/async-storage/request-store.js:33-38) — the read is always " +
        "null. Only a custom Worker entry's fetch sees them: src/worker/admin-rsc-sampler.ts (OPE-1397)."
    ).toEqual([]);
  });

  it("only the Worker-entry sampler calls isAnonymousAdminRscRequest", () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f.rel) && /\bisAnonymousAdminRscRequest\b/.test(f.text))
      .map((f) => f.rel);
    expect(
      offenders,
      "isAnonymousAdminRscRequest is always false behind Next (flight headers are stripped " +
        "by next/dist/server/web/adapter.js:137-146 and request-store.js:33-38). Call it only " +
        "from a custom Worker entry: src/worker/admin-rsc-sampler.ts (OPE-1397)."
    ).toEqual([]);
  });
});
