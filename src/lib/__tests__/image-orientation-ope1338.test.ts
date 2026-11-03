/**
 * OPE-1338 — a phone photo with EXIF Orientation ≠ 1 must be stored upright.
 *
 * Phase 2a strips APP1 (and with it the Orientation tag) before Phase 2b's
 * `cf.image` transform reads the stored copy, so the transform had nothing to
 * auto-orient from: gallery photo 3bda4785 (Orientation=3) was stored upside
 * down. The hero from the same batch looked fine only because its source was
 * Orientation=1 — the role was never the variable.
 *
 * The fix reads Orientation before the strip and passes explicit
 * `rotate`/`flip` to `cf.image`. These tests pin the reader, the mapping, and —
 * the part a helper-only test cannot show — that the pipeline actually hands
 * the rotation to the transform it ships.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const transformSpy = vi.fn();
vi.mock("../image-optim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../image-optim")>();
  return {
    ...actual,
    transformViaCloudflare: (url: string, opts?: unknown) => transformSpy(url, opts),
  };
});

import { readJpegOrientation, orientationToCfImage, stripExifFromJpeg } from "../image-optim";
import { runUploadPipeline } from "../upload-image-pipeline";

/** A minimal JPEG: SOI, an EXIF APP1 carrying IFD0 Orientation, optional
 *  padding in an APP15 segment (which the strip keeps), SOS, scan, EOI. */
function jpegWithOrientation(
  orientation: number | null,
  { littleEndian = true, padTo = 0 }: { littleEndian?: boolean; padTo?: number } = {}
): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (orientation !== null) {
    const u16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
    const u32 = (v: number) =>
      littleEndian
        ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
        : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const tiff = [
      ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42),
      ...u32(8), // IFD0 right after the header
      ...u16(2), // two entries: one unrelated tag first, then Orientation
      ...u16(0x010f), // Make
      ...u16(2),
      ...u32(1),
      ...u32(0),
      ...u16(0x0112), // Orientation, SHORT, count 1, value inline
      ...u16(3),
      ...u32(1),
      ...u16(orientation),
      0,
      0,
      ...u32(0), // no next IFD
    ];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = payload.length + 2;
    out.push(0xff, 0xe1, len >> 8, len & 0xff, ...payload);
  }
  // Padding the strip keeps, so a test can clear the Phase 2b small-input skip.
  let remaining = padTo;
  while (remaining > 0) {
    const n = Math.min(remaining, 60_000);
    const len = n + 2;
    out.push(0xff, 0xef, len >> 8, len & 0xff);
    for (let k = 0; k < n; k++) out.push(0);
    remaining -= n;
  }
  out.push(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9);
  return new Uint8Array(out);
}

describe("readJpegOrientation (OPE-1338)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("reads Orientation=%i (little-endian)", (o) => {
    expect(readJpegOrientation(jpegWithOrientation(o))).toBe(o);
  });

  it("reads big-endian (Motorola) EXIF too", () => {
    expect(readJpegOrientation(jpegWithOrientation(6, { littleEndian: false }))).toBe(6);
  });

  it("returns null without EXIF, for non-JPEG input, and for out-of-range values", () => {
    expect(readJpegOrientation(jpegWithOrientation(null))).toBeNull();
    expect(readJpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readJpegOrientation(jpegWithOrientation(9))).toBeNull();
  });

  it("never throws on a truncated EXIF segment", () => {
    const full = jpegWithOrientation(3);
    expect(() => readJpegOrientation(full.slice(0, 20))).not.toThrow();
  });

  it("the tag is GONE after the Phase 2a strip — the reason it must be read first", () => {
    const stripped = stripExifFromJpeg(jpegWithOrientation(3)).bytes;
    expect(readJpegOrientation(stripped)).toBeNull();
  });
});

describe("orientationToCfImage (OPE-1338)", () => {
  it("maps every EXIF value to clockwise rotate / flip-before-rotate", () => {
    expect(orientationToCfImage(1)).toEqual({});
    expect(orientationToCfImage(2)).toEqual({ flip: "h" });
    expect(orientationToCfImage(3)).toEqual({ rotate: 180 });
    expect(orientationToCfImage(4)).toEqual({ flip: "v" });
    expect(orientationToCfImage(5)).toEqual({ flip: "h", rotate: 270 });
    expect(orientationToCfImage(6)).toEqual({ rotate: 90 });
    expect(orientationToCfImage(7)).toEqual({ flip: "h", rotate: 90 });
    expect(orientationToCfImage(8)).toEqual({ rotate: 270 });
    expect(orientationToCfImage(null)).toEqual({});
    expect(orientationToCfImage(undefined)).toEqual({});
  });

  it("transformViaCloudflare puts the rotation into cf.image", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x52]).buffer, {
        status: 200,
        headers: { "content-type": "image/webp" },
      })
    );
    // The module-level mock replaces transformViaCloudflare; test the real one.
    const { transformViaCloudflare: realTransform } =
      await vi.importActual<typeof import("../image-optim")>("../image-optim");
    await realTransform("https://cdn.example.com/x.jpg", {
      orientation: 6,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy.mock.calls[0][1].cf.image).toMatchObject({ rotate: 90 });
  });
});

describe("runUploadPipeline hands the source orientation to Phase 2b (OPE-1338)", () => {
  /** An R2 stand-in: records puts, HEAD always finds the key. */
  function fakeBucket() {
    const puts: string[] = [];
    return {
      puts,
      bucket: {
        put: vi.fn(async (key: string) => {
          puts.push(key);
        }),
        head: vi.fn(async () => ({})),
        delete: vi.fn(async () => {}),
      },
    };
  }

  beforeEach(() => {
    transformSpy.mockReset();
    transformSpy.mockResolvedValue({
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      originalBytes: 70_000,
      finalBytes: 4,
      contentType: "image/webp",
      width: 2000,
      height: 1500,
      durationMs: 1,
    });
  });

  async function upload(orientation: number | null) {
    transformSpy.mockClear();
    const { bucket } = fakeBucket();
    // A DB stub that throws if touched: the gallery/D1 write comes after the
    // transform, and this test is only about what reaches the transform.
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("stop-after-transform");
        },
      }
    );
    try {
      await runUploadPipeline({
        bytes: jpegWithOrientation(orientation, { padTo: 70_000 }),
        declaredType: "image/jpeg",
        fileName: "IMG_20261008_110308576.jpg",
        targetType: "event",
        targetId: "d603761b-751a-4111-9b11-c46e88df8047",
        imageRole: "gallery",
        caption: null,
        actorId: "test",
        uploadSource: "test",
        db: db as never,
        env: { VENDOR_ASSETS: bucket as never },
      });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "stop-after-transform") throw e;
    }
    expect(transformSpy).toHaveBeenCalledTimes(1);
    return transformSpy.mock.calls[0][1] as { orientation?: number | null };
  }

  it.each([3, 6, 8])(
    "a gallery JPEG with Orientation=%i is transformed with that orientation",
    async (o) => {
      const opts = await upload(o);
      expect(opts.orientation).toBe(o);
    }
  );

  it("an upright source (Orientation=1) and a source with no EXIF ask for no rotation", async () => {
    expect((await upload(1)).orientation).toBe(1);
    expect(orientationToCfImage((await upload(1)).orientation)).toEqual({});
    expect((await upload(null)).orientation ?? null).toBeNull();
  });
});
