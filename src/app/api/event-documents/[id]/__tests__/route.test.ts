/**
 * OPE-1580 — the public download route only serves a live, unexpired form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let dbRows: unknown[] = [];
const bucketGet = vi.fn();

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

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const doc = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  r2Key: "event-documents/ev1/d1.pdf",
  displayName: "Vendor application",
  mimeType: "application/pdf",
  sizeBytes: 21,
  status: "live",
  expiresAt: FUTURE,
  ...over,
});
const call = () =>
  GET(new NextRequest("https://x.test/api/event-documents/d1"), {
    params: Promise.resolve({ id: "d1" }),
  });

describe("GET /api/event-documents/[id]", () => {
  beforeEach(() => {
    dbRows = [];
    bucketGet.mockReset();
    bucketGet.mockResolvedValue({ body: "file-bytes" });
  });

  it("serves a live form as a no-store download", async () => {
    dbRows = [doc()];
    const res = await call();
    expect(res.status).toBe(200);
    expect(bucketGet).toHaveBeenCalledWith("event-documents/ev1/d1.pdf");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Vendor application.pdf"'
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s a withdrawn form without reading R2", async () => {
    dbRows = [doc({ status: "withdrawn" })];
    expect((await call()).status).toBe(404);
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("404s an expired form without reading R2", async () => {
    dbRows = [doc({ expiresAt: PAST })];
    expect((await call()).status).toBe(404);
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("404s an unknown id", async () => {
    expect((await call()).status).toBe(404);
  });

  it("404s when the row is live but the file is gone", async () => {
    dbRows = [doc()];
    bucketGet.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
