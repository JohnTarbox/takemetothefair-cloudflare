/**
 * OPE-1377 — GET /api/admin/inbound-attachment/[token] (OPE-409 download slot).
 *
 * No session: the slot token is the authorization for ONE attachment of ONE
 * email. Negative: unknown and revoked/expired (evicted from KV) tokens → flat
 * 404 with R2 never read. Positive: a live slot streams exactly the attachment
 * it was minted for, as a no-store download.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  issueAttachmentDownloadSlot,
  revokeAttachmentDownloadSlot,
} from "@/lib/attachment-download-token";

class FakeKv {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.store.set(k, v);
  }
  async delete(k: string) {
    this.store.delete(k);
  }
}

let kv = new FakeKv();
const bucketGet = vi.fn();
let dbRows: unknown[] = [];

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(dbRows) }),
      }),
    }),
  }),
  getCloudflareEnv: () => ({ VENDOR_ASSETS: { get: bucketGet } }),
  getCloudflareRateLimitKv: () => kv,
}));

import { GET } from "../route";

const get = (token: string) =>
  GET(new NextRequest(`https://example.com/api/admin/inbound-attachment/${token}`), {
    params: Promise.resolve({ token }),
  });

const refs = JSON.stringify([
  { key: "inbound-attachments/g/0-a.png", name: "a.png", mimeType: "image/png", size: 3 },
  { key: "inbound-attachments/g/1-b.pdf", name: "b.pdf", mimeType: "application/pdf", size: 3 },
]);

beforeEach(() => {
  kv = new FakeKv();
  bucketGet.mockReset();
  dbRows = [{ attachmentRefs: refs }];
});

describe("GET /api/admin/inbound-attachment/[token] (OPE-1377)", () => {
  it("unknown token → 404, R2 never read", async () => {
    const res = await get("not-a-real-download-slot-0000");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("revoked / expired slot → 404, R2 never read", async () => {
    const slot = await issueAttachmentDownloadSlot(kv as unknown as KVNamespace, {
      inboundEmailId: "ie1",
      index: 1,
      issuedBy: "admin-1",
    });
    await revokeAttachmentDownloadSlot(kv as unknown as KVNamespace, slot.token);
    const res = await get(slot.token);
    expect(res.status).toBe(404);
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it("a live slot streams only the attachment it was minted for, no-store", async () => {
    bucketGet.mockResolvedValue({ body: "PDF", httpMetadata: {} });
    const slot = await issueAttachmentDownloadSlot(kv as unknown as KVNamespace, {
      inboundEmailId: "ie1",
      index: 1,
      issuedBy: "admin-1",
    });
    const res = await get(slot.token);
    expect(res.status).toBe(200);
    expect(bucketGet).toHaveBeenCalledWith("inbound-attachments/g/1-b.pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="b.pdf"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
