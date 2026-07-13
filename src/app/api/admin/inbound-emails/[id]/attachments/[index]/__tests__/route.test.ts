/**
 * OPE-187 — /api/admin/inbound-emails/[id]/attachments/[index] guard rails.
 * Admin-only; bad index → 400; a ref key outside the inbound-attachments/ prefix
 * → 403 (defense-in-depth so a tampered ref can't read arbitrary R2 objects);
 * happy path streams the R2 object inline (attachment when ?dl=1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
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
  getCloudflareEnv: () => ({ VENDOR_ASSETS: { get: bucketGet } }),
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
