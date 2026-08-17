/**
 * OPE-187 — /api/admin/inbound-emails/[id]/attachments/[index] guard rails.
 * Admin-only; bad index → 400; a ref key outside the inbound-attachments/ prefix
 * → 403 (defense-in-depth so a tampered ref can't read arbitrary R2 objects);
 * happy path streams the R2 object inline (attachment when ?dl=1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
// OPE-409 — lets a test present an INTERNAL_API_KEY so the agent path is exercised.
let envExtra: Record<string, unknown> = {};
const bucketGet = vi.fn();
let dbRows: unknown[] = [];

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(dbRows) }),
      }),
    }),
  }),
  getCloudflareEnv: () => ({ VENDOR_ASSETS: { get: bucketGet }, ...envExtra }),
}));

import { GET } from "../route";

const req = (url = "http://localhost/api/admin/inbound-emails/e1/attachments/0") =>
  new NextRequest(url, { method: "GET" });
const params = (id = "e1", index = "0") => ({ params: Promise.resolve({ id, index }) });
const refs = (key: string) =>
  JSON.stringify([{ key, name: "poster.png", mimeType: "image/png", size: 42 }]);

beforeEach(() => {
  authMock.mockReset();
  bucketGet.mockReset();
  dbRows = [];
  envExtra = {};
});

describe("GET attachments route — guards (OPE-187)", () => {
  it("401 for a non-admin", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
  });

  it("400 on a non-numeric index", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    const res = await GET(req(), params("e1", "abc"));
    expect(res.status).toBe(400);
  });

  it("403 when the ref key is outside the inbound-attachments/ prefix", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    dbRows = [{ attachmentRefs: refs("mmatf-vendor-assets/evil.png") }];
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("404 when the row has no attachments", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    dbRows = [{ attachmentRefs: null }];
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
  });

  it("streams the object inline for a valid inbound-attachments key", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    dbRows = [{ attachmentRefs: refs("inbound-attachments/g/0-poster.png") }];
    bucketGet.mockResolvedValue({ body: "IMGBYTES", httpMetadata: { contentType: "image/png" } });
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe('inline; filename="poster.png"');
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("forces attachment disposition for image/svg+xml (XSS defense — svg can script)", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    dbRows = [
      {
        attachmentRefs: JSON.stringify([
          {
            key: "inbound-attachments/g/0-x.svg",
            name: "x.svg",
            mimeType: "image/svg+xml",
            size: 9,
          },
        ]),
      },
    ];
    bucketGet.mockResolvedValue({ body: "<svg/>", httpMetadata: { contentType: "image/svg+xml" } });
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    // NOT inline — svg is excluded from the safe-inline allowlist.
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="x.svg"');
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("uses attachment disposition when ?dl=1", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    dbRows = [{ attachmentRefs: refs("inbound-attachments/g/0-poster.png") }];
    bucketGet.mockResolvedValue({ body: "IMGBYTES", httpMetadata: { contentType: "image/png" } });
    const res = await GET(
      req("http://localhost/api/admin/inbound-emails/e1/attachments/0?dl=1"),
      params()
    );
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="poster.png"');
  });
});

/**
 * OPE-409 — recovery has to be callable by an AGENT, not just a logged-in human.
 *
 * The 2026-08-15 rescue pulled five photos out of this prefix and re-uploaded
 * them. That workflow is the reason the public CDN path cannot simply be closed,
 * and a session-only download would have made "close it" mean "lose the ability
 * to rescue photos the pipeline drops".
 */
describe("GET attachments route — internal service key (OPE-409)", () => {
  const withKey = (key: string) =>
    new NextRequest("http://localhost/api/admin/inbound-emails/e1/attachments/0", {
      method: "GET",
      headers: { "x-internal-key": key },
    });

  it("serves an attachment to a caller presenting the internal key, with NO session", async () => {
    envExtra = { INTERNAL_API_KEY: "secret-key" };
    authMock.mockResolvedValue(null); // explicitly nobody logged in
    dbRows = [{ attachmentRefs: refs("inbound-attachments/msg1/0-poster.png") }];
    bucketGet.mockResolvedValue({ body: new ReadableStream(), httpMetadata: {} });

    const res = await GET(withKey("secret-key"), params());
    expect(res.status).toBe(200);
    expect(bucketGet).toHaveBeenCalled();
  });

  it("rejects a WRONG internal key and falls back to the session check", async () => {
    envExtra = { INTERNAL_API_KEY: "secret-key" };
    authMock.mockResolvedValue(null);
    const res = await GET(withKey("not-the-key"), params());
    expect(res.status).toBe(401);
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("a key header is worthless when the server has no INTERNAL_API_KEY configured", async () => {
    // Guards the misconfiguration where an absent env var would otherwise make
    // `undefined === undefined` authenticate everybody.
    envExtra = {};
    authMock.mockResolvedValue(null);
    const res = await GET(withKey(""), params());
    expect(res.status).toBe(401);
  });

  it("the prefix guard still applies to internal callers", async () => {
    // Authentication is not authorization to read arbitrary R2 objects.
    envExtra = { INTERNAL_API_KEY: "secret-key" };
    authMock.mockResolvedValue(null);
    dbRows = [{ attachmentRefs: refs("vendors/logo.png") }];
    const res = await GET(withKey("secret-key"), params());
    expect(res.status).toBe(403);
    expect(bucketGet).not.toHaveBeenCalled();
  });
});
