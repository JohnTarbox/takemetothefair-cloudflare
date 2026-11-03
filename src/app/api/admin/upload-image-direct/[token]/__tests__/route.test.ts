/**
 * OPE-1377 — POST /api/admin/upload-image-direct/[token].
 *
 * No session: the one-shot upload slot in the path is the authorization, and
 * the slot's claims (not the request) fix the write target. Negative: an
 * unknown token, and a slot that was already consumed, → 401 with the pipeline
 * never invoked. Positive: a freshly-issued slot runs the pipeline against the
 * target the slot was minted for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueUploadSlot } from "@/lib/upload-slot-token";

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

let kv: FakeKv | null = new FakeKv();
const runUploadPipeline = vi.fn(async () => ({
  ok: true as const,
  body: { url: "https://cdn/x.png" },
}));

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({}),
  getCloudflareEnv: () => ({}),
  getCloudflareRateLimitKv: () => kv,
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => undefined) }));
vi.mock("@/lib/upload-image-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upload-image-pipeline")>()),
  runUploadPipeline: (...a: unknown[]) => runUploadPipeline(...(a as [])),
}));

import { POST } from "../route";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const post = (token: string) =>
  POST(
    new NextRequest(`https://example.com/api/admin/upload-image-direct/${token}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG,
    }),
    { params: Promise.resolve({ token }) }
  );

beforeEach(() => {
  kv = new FakeKv();
  runUploadPipeline.mockClear();
});

describe("POST /api/admin/upload-image-direct/[token] (OPE-1377)", () => {
  it("unknown token → 401, pipeline never runs", async () => {
    const res = await post("not-a-real-slot-token-000000");
    expect(res.status).toBe(401);
    expect(runUploadPipeline).not.toHaveBeenCalled();
  });

  it("missing KV binding → the same generic 401 (no token-vs-infra oracle)", async () => {
    kv = null;
    const res = await post("whatever-token-0000000000000");
    expect(res.status).toBe(401);
    expect(runUploadPipeline).not.toHaveBeenCalled();
  });

  it("a valid slot uploads to the slot's target once; reusing it → 401", async () => {
    const slot = await issueUploadSlot(kv as unknown as KVNamespace, {
      targetType: "vendor",
      targetId: "vendor-1",
      imageRole: "logo",
      issuedBy: "admin-1",
    });

    const res = await post(slot.token);
    expect(res.status).toBe(200);
    expect(runUploadPipeline).toHaveBeenCalledTimes(1);
    expect(runUploadPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "vendor",
        targetId: "vendor-1",
        imageRole: "logo",
        actorId: "admin-1",
        declaredType: "image/png",
      })
    );

    const replay = await post(slot.token);
    expect(replay.status).toBe(401);
    expect(runUploadPipeline).toHaveBeenCalledTimes(1);
  });
});
