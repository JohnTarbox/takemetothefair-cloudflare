import { describe, it, expect, vi } from "vitest";
import {
  attachGeneralPhotos,
  type GeneralPhotoEnv,
  type GeneralPhoto,
} from "../src/photo/general-photos.js";

/** R2 stub returning fixed bytes for any key (mirrors photo-booth-pipeline.test). */
const bucket = (present = true) =>
  ({
    get: vi.fn().mockResolvedValue(
      present
        ? {
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            httpMetadata: { contentType: "image/jpeg" },
          }
        : null
    ),
  }) as unknown as R2Bucket;

const photo = (n = "a.jpg"): GeneralPhoto => ({ key: `inbound-attachments/g1/${n}`, name: n });

/** Captures what we POST to the main app. */
function fetchStub(ok = true) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (req: Request) => {
    calls.push({ url: req.url, init: { method: req.method, body: req.body } });
    return new Response(JSON.stringify(ok ? { url: "https://cdn/x.webp" } : { error: "nope" }), {
      status: ok ? 200 : 500,
    });
  });
  return { fn, calls };
}

const env = (over: Partial<GeneralPhotoEnv> = {}): GeneralPhotoEnv => ({
  VENDOR_ASSETS: bucket(),
  MAIN_APP_URL: "https://app.test",
  INTERNAL_API_KEY: "k",
  ...over,
});

describe("attachGeneralPhotos", () => {
  it("does nothing, loudly, when unconfigured", async () => {
    // A missing binding must be REPORTED, not silently treated as "0 photos".
    const r = await attachGeneralPhotos({ MAIN_APP_URL: "x" }, "e1", [photo()]);
    expect(r.attached).toBe(0);
    expect(r.disabledReason).toContain("required");
  });

  it("is a no-op for an empty batch without touching R2", async () => {
    const b = bucket();
    const r = await attachGeneralPhotos(env({ VENDOR_ASSETS: b }), "e1", []);
    expect(r).toEqual({ attached: 0, failed: 0 });
    expect(b.get).not.toHaveBeenCalled();
  });

  it("posts each photo to the event's gallery, never a scalar column", async () => {
    const { fn, calls } = fetchStub();
    const r = await attachGeneralPhotos(env({ MAIN_APP: { fetch: fn as never } }), "evt-1", [
      photo("a.jpg"),
      photo("b.jpg"),
    ]);
    expect(r).toEqual({ attached: 2, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://app.test/api/admin/upload-image-bytes");
  });

  it("counts a failed upload instead of dropping it", async () => {
    // The reply has to be able to tell John a photo didn't land.
    const { fn } = fetchStub(false);
    const r = await attachGeneralPhotos(env({ MAIN_APP: { fetch: fn as never } }), "e1", [photo()]);
    expect(r).toEqual({ attached: 0, failed: 1 });
  });

  it("counts a missing R2 object as failed, not attached", async () => {
    const { fn } = fetchStub();
    const r = await attachGeneralPhotos(
      env({ VENDOR_ASSETS: bucket(false), MAIN_APP: { fetch: fn as never } }),
      "e1",
      [photo()]
    );
    expect(r).toEqual({ attached: 0, failed: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("one bad photo does not sink the batch", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("network");
      return new Response("{}", { status: 200 });
    });
    const r = await attachGeneralPhotos(env({ MAIN_APP: { fetch: fn as never } }), "e1", [
      photo("a.jpg"),
      photo("b.jpg"),
    ]);
    expect(r).toEqual({ attached: 1, failed: 1 });
  });
});
