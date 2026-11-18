/**
 * OPE-1684 — the MCP side of repointing: `repoint_blog_links` forwards to the
 * main app with dry_run defaulting to TRUE, and `update_blog_post` with
 * `repoint_links` repoints only when the slug actually changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CapturingMcpServer, createTestDb } from "./setup-db.js";
import { registerBlogTools } from "../src/tools/blog.js";

const ENV = { MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "k" };
const ADMIN = { userId: "u-admin", role: "ADMIN" as const, email: "admin@test" };

let server: CapturingMcpServer;
let calls: Array<{ url: string; method: string; body: Record<string, unknown> }>;
let slugChange: { old: string; new: string } | null;

beforeEach(() => {
  calls = [];
  slugChange = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.endsWith("/repoint-links")) {
      return new Response(JSON.stringify({ success: true, dryRun: body.dryRun, postsUpdated: 2 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ slug: "x", slugChange }), { status: 200 });
  });
  const { db } = createTestDb();
  server = new CapturingMcpServer();
  registerBlogTools(server as never, db, ADMIN as never, ENV as never);
});
afterEach(() => vi.unstubAllGlobals());

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};

describe("OPE-1684 — repoint_blog_links", () => {
  it("defaults to a dry run", async () => {
    const r = await call("repoint_blog_links", { from_slug: "old-guide", to_slug: "new-guide" });
    expect(r.isError).toBe(false);
    expect(calls).toEqual([
      {
        url: "https://app.test/api/admin/blog-posts/repoint-links",
        method: "POST",
        body: { fromSlug: "old-guide", toSlug: "new-guide", dryRun: true },
      },
    ]);
  });

  it("dry_run: false applies", async () => {
    await call("repoint_blog_links", { from_slug: "a", to_slug: "b", dry_run: false });
    expect(calls[0].body.dryRun).toBe(false);
  });

  it("update_blog_post + repoint_links repoints old → new after a slug move", async () => {
    slugChange = { old: "old-guide", new: "new-guide" };
    const r = await call("update_blog_post", {
      slug: "old-guide",
      new_slug: "new-guide",
      repoint_links: true,
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://app.test/api/blog-posts/old-guide",
      "https://app.test/api/admin/blog-posts/repoint-links",
    ]);
    expect(calls[1].body).toEqual({ fromSlug: "old-guide", toSlug: "new-guide", dryRun: false });
    expect(r.body.repointLinks).toMatchObject({ ok: true, postsUpdated: 2 });
  });

  it("update_blog_post + repoint_links without a slug change calls no repoint", async () => {
    const r = await call("update_blog_post", { slug: "g", title: "T", repoint_links: true });
    expect(calls).toHaveLength(1);
    expect(r.body.repointLinks.skipped).toMatch(/did not change/);
  });
});

describe("OPE-1684 — repoint goes through the MAIN_APP service binding (OPE-258)", () => {
  it("uses env.MAIN_APP when bound, never a public same-zone fetch", async () => {
    const bound: Array<{ url: string; host: string | null; key: string | null; body: unknown }> =
      [];
    const MAIN_APP = {
      fetch: async (req: Request) => {
        bound.push({
          url: req.url,
          host: req.headers.get("host"),
          key: req.headers.get("x-internal-key"),
          body: await req.json(),
        });
        return new Response(JSON.stringify({ success: true, dryRun: true }), { status: 200 });
      },
    };
    const { db } = createTestDb();
    const s2 = new CapturingMcpServer();
    registerBlogTools(s2 as never, db, ADMIN as never, { ...ENV, MAIN_APP } as never);
    const r = (await s2.invoke("repoint_blog_links", { from_slug: "a", to_slug: "b" })) as {
      isError?: boolean;
    };
    expect(r.isError).toBeFalsy();
    expect(bound).toEqual([
      {
        url: "https://app.test/api/admin/blog-posts/repoint-links",
        host: "app.test",
        key: "k",
        body: { fromSlug: "a", toSlug: "b", dryRun: true },
      },
    ]);
    expect(calls).toEqual([]); // the stubbed public fetch was never reached
  });
});
