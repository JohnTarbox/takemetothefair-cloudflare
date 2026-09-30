/**
 * OPE-409 — `upload_event_image` must read our own `inbound-attachments/` objects
 * through the R2 binding, never over the public CDN edge.
 *
 * John's direction of 2026-08-27 made this the precondition for the WAF rule
 * that closes that prefix: held posters are attached by handing this tool a
 * `cdn.meetmeatthefair.com/inbound-attachments/…` URL, and a WAF rule cannot
 * exempt our own server-side fetch. A public fetch would break poster
 * attachment for every size — and fail as "the image just doesn't attach".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const KEY = "inbound-attachments/CAEv_qq123-mail.gmail.com/0-poster.png";
const CDN_URL = `https://cdn.meetmeatthefair.com/${KEY}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let db: TestDb;
let server: CapturingMcpServer;
let fetchSpy: ReturnType<typeof vi.fn>;
let realFetch: typeof fetch;
let bucketGets: string[];

function bucket(objects: Record<string, Uint8Array>) {
  return {
    async get(key: string) {
      bucketGets.push(key);
      const bytes = objects[key];
      if (!bytes) return null;
      return {
        body: new Response(bytes as BlobPart).body!,
        size: bytes.byteLength,
        httpMetadata: { contentType: "image/png" },
      };
    },
  };
}

function register(env: Record<string, unknown>) {
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, {
    MAIN_APP_URL: "https://meetmeatthefair.com",
    INTERNAL_API_KEY: "test-key",
    ...env,
  } as never);
}

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({ id: "e1", name: "Fair", slug: "fair", promoterId: "p1", status: "APPROVED" })
    .run();
  bucketGets = [];
  realFetch = globalThis.fetch;
  // Only the main-app upload POST may leave the Worker. Anything else — in
  // particular a GET of the CDN URL — is recorded and answered with the 403 the
  // WAF rule will return, so a regression fails the call instead of passing.
  fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/admin/events/e1/upload-image") && init?.method === "POST") {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      return Response.json({
        url: "https://cdn.meetmeatthefair.com/events/e1/hero.webp",
        key: "events/e1/hero.webp",
        receivedBytes: file.size,
      });
    }
    return new Response("<html>blocked</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    });
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const cdnFetches = () =>
  fetchSpy.mock.calls.filter(([input]) =>
    String(input instanceof Request ? input.url : input).startsWith("https://cdn.")
  );

describe("upload_event_image on an inbound-attachments URL (OPE-409)", () => {
  it("reads the object through VENDOR_ASSETS and never fetches the CDN", async () => {
    register({ VENDOR_ASSETS: bucket({ [KEY]: PNG }) });
    const res = (await server.invoke("upload_event_image", {
      event_id: "e1",
      image_url: CDN_URL,
    })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(res.isError).toBeFalsy();
    // Positive landmark: the binding was actually read, for exactly this key.
    expect(bucketGets).toEqual([KEY]);
    expect(JSON.parse(res.content[0].text).bytes).toBe(PNG.byteLength);
    // The guard: no request to the public edge the WAF rule closes.
    expect(cdnFetches()).toHaveLength(0);
  });

  it("refuses loudly when the binding is absent, rather than falling back to the public edge", async () => {
    register({});
    const res = (await server.invoke("upload_event_image", {
      event_id: "e1",
      image_url: CDN_URL,
    })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/VENDOR_ASSETS/);
    expect(cdnFetches()).toHaveLength(0);
  });

  it("a published derivative on the CDN is still fetched normally (the binding is only for the closed prefix)", async () => {
    register({ VENDOR_ASSETS: bucket({}) });
    await server.invoke("upload_event_image", {
      event_id: "e1",
      image_url: "https://cdn.meetmeatthefair.com/events/other/hero.webp",
    });
    expect(bucketGets).toEqual([]);
    expect(cdnFetches().length).toBeGreaterThan(0);
  });
});
