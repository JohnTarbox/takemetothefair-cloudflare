import { describe, it, expect, vi } from "vitest";
import { ImageTransformError, transformViaCloudflare } from "../image-optim";

/** Build a mock fetch that records its call args and returns a canned
 *  Response. The transformViaCloudflare contract is that fetch is called
 *  exactly once with the cf.image option populated. */
function mockFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

function webpResponse(bodyBytes: Uint8Array, headers: Record<string, string> = {}) {
  // Construct a fresh ArrayBuffer-backed body — TS's Response constructor
  // wants BodyInit which excludes Uint8Array<ArrayBufferLike>. The .buffer
  // dereference + slice() guarantees an ArrayBuffer view.
  const body = bodyBytes.slice().buffer;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/webp",
      ...headers,
    },
  });
}

describe("transformViaCloudflare", () => {
  it("passes the analyst-spec defaults (2000px / scale-down / webp / q85) to cf.image", async () => {
    const fakeBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF placeholder
    const fetchSpy = mockFetch(webpResponse(fakeBytes));

    await transformViaCloudflare("https://cdn.example.com/x.jpg", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://cdn.example.com/x.jpg");
    expect(init.cf.image).toEqual({
      width: 2000,
      height: 2000,
      fit: "scale-down",
      format: "webp",
      quality: 85,
      metadata: "none",
    });
  });

  it("honors caller overrides for maxLongestEdge and quality", async () => {
    const fetchSpy = mockFetch(webpResponse(new Uint8Array([0x52])));
    await transformViaCloudflare("https://cdn.example.com/x.jpg", {
      maxLongestEdge: 1024,
      quality: 70,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.cf.image.width).toBe(1024);
    expect(init.cf.image.height).toBe(1024);
    expect(init.cf.image.quality).toBe(70);
  });

  it("returns the WebP bytes, dimensions, and timing", async () => {
    const fakeBytes = new Uint8Array(2048);
    const fetchSpy = mockFetch(
      webpResponse(fakeBytes, {
        "cf-resized-image-width": "1500",
        "cf-resized-image-height": "1000",
        "x-original-content-length": "4096000",
      })
    );

    const result = await transformViaCloudflare("https://cdn.example.com/x.jpg", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.bytes.length).toBe(2048);
    expect(result.finalBytes).toBe(2048);
    expect(result.originalBytes).toBe(4096000);
    expect(result.contentType).toBe("image/webp");
    expect(result.width).toBe(1500);
    expect(result.height).toBe(1000);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns null dimensions when Cloudflare omits the headers", async () => {
    const fetchSpy = mockFetch(webpResponse(new Uint8Array(100)));
    const result = await transformViaCloudflare("https://cdn.example.com/x.jpg", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
  });

  it("falls back to finalBytes when X-Original-Content-Length is missing", async () => {
    const fetchSpy = mockFetch(webpResponse(new Uint8Array(500)));
    const result = await transformViaCloudflare("https://cdn.example.com/x.jpg", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    // No header → originalBytes defaults to body length (compression
    // ratio observability degrades gracefully).
    expect(result.originalBytes).toBe(500);
  });

  it("throws ImageTransformError when the transform returns non-2xx", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("Image Resizing not enabled", {
        status: 403,
        headers: { "content-type": "text/plain" },
      })
    );

    await expect(
      transformViaCloudflare("https://cdn.example.com/x.jpg", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      })
    ).rejects.toThrow(ImageTransformError);

    // Reset and re-throw to inspect the error fields
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(
      new Response("Image Resizing not enabled", {
        status: 403,
        headers: { "content-type": "text/plain" },
      })
    );
    try {
      await transformViaCloudflare("https://cdn.example.com/x.jpg", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ImageTransformError);
      expect((e as ImageTransformError).status).toBe(403);
      expect((e as ImageTransformError).detail).toContain("Image Resizing not enabled");
    }
  });

  it("throws ImageTransformError when the response content-type isn't image/*", async () => {
    // Sentinel for "Image Resizing not actually enabled on the zone" —
    // Cloudflare may return the source URL's HTML 404 page (text/html)
    // instead of an image. Catch this so the caller falls back.
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("<html>Not Found</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    await expect(
      transformViaCloudflare("https://cdn.example.com/x.jpg", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      })
    ).rejects.toThrow(/unexpected content-type/);
  });

  it("throws ImageTransformError when fetch itself rejects", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network down"));
    await expect(
      transformViaCloudflare("https://cdn.example.com/x.jpg", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      })
    ).rejects.toThrow(/fetch failed: network down/);
  });
});
