/**
 * OPE-1370 — the promoter og:image probe checked the first hop only, had no
 * timeout at all, and downloaded the whole image when a CDN ignored Range.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probePromoterImage, PROBE_TIMEOUT_MS } from "../src/enrichment/promoter-image.js";

/** PNG signature + IHDR declaring 1600×600. */
const WIDE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x06, 0x40, 0x00, 0x00, 0x02, 0x58, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("probePromoterImage (OPE-1370)", () => {
  it("refuses an image URL that redirects to [::7f00:1], without requesting the hop", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return init?.redirect === "manual"
        ? new Response(null, { status: 302, headers: { location: "http://[::7f00:1]/a.png" } })
        : // What an unguarded, runtime-followed fetch would read off the
          // internal hop: a wide PNG that classifies as a confident hero.
          new Response(WIDE_PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const r = await probePromoterImage("https://promoter.example.org/og.png");
    expect(r).toMatchObject({ width: null, classification: "logo", heroConfident: false });
    expect(seen).toEqual(["https://promoter.example.org/og.png"]);
  });

  it("gives up on a stalled CDN after PROBE_TIMEOUT_MS instead of hanging", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    ) as unknown as typeof fetch;
    let settled = false;
    const p = probePromoterImage("https://slow.example.org/og.png").then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    expect(settled).toBe(true);
    expect(await p).toMatchObject({ width: null, classification: "logo" });
  });
});
