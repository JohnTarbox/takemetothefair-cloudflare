/**
 * OPE-1301 — /blog/tag/[tag] on a D1 platform reset: retry once, then render the
 * honest degraded panel (not the error boundary). A query DEFECT still throws.
 *
 * Driven through the real page module and the real retry wrapper; only the DB
 * handle is faked, so the fault enters exactly where D1 would raise it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement } from "react";

let calls = 0;
let failWith: Error | null = null;

/** A drizzle-shaped chain whose terminal await throws `failWith` (or resolves []). */
function fakeDb() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "leftJoin", "where", "orderBy"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    calls++;
    return failWith
      ? Promise.reject(failWith).then(resolve, reject)
      : Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => fakeDb() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no request context in tests");
  },
}));

const { default: BlogTagPage, generateMetadata } = await import("../page");
const props = { params: Promise.resolve({ tag: "connecticut" }) };

beforeEach(() => {
  calls = 0;
  failWith = null;
  vi.useFakeTimers();
});

async function run<T>(p: Promise<T>): Promise<T> {
  // The retry waits a jittered moment; advance past it.
  await vi.runAllTimersAsync();
  return p;
}

describe("OPE-1301 — the blog tag page on a D1 platform reset", () => {
  it("retries once, then renders the degraded panel instead of throwing", async () => {
    failWith = new Error(
      "D1_ERROR: storage operation exceeded timeout which caused object to be reset"
    );
    const el = await run(BlogTagPage(props));
    expect(calls).toBe(2); // the first attempt + one retry
    expect(isValidElement(el)).toBe(true);
    const type = (el as { type: { name?: string } }).type;
    expect(type.name).toBe("DegradedPanel");
  });

  it("metadata is noindex on the same fault", async () => {
    failWith = new Error(
      "D1_ERROR: storage operation exceeded timeout which caused object to be reset"
    );
    const meta = await run(generateMetadata(props));
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("a query DEFECT is not retried and still throws to the error boundary", async () => {
    failWith = new Error("D1_ERROR: no such column: blog_posts.nope: SQLITE_ERROR");
    const p = BlogTagPage(props);
    const settled = p.then(
      () => "resolved",
      (e: Error) => e.message
    );
    await vi.runAllTimersAsync();
    expect(await settled).toContain("no such column");
    expect(calls).toBe(1);
  });
});
