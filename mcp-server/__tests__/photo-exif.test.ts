import { describe, it, expect } from "vitest";
import { parseExif } from "../src/photo/exif.js";

/**
 * Builds a real EXIF JPEG byte-for-byte, so the parser is exercised against
 * actual structure (marker chain → TIFF header → IFD0 → sub-IFDs) rather than
 * a mock. Little-endian ("II"), which is what iPhones and most cameras emit.
 */
function buildJpegWithExif(opts: {
  gps?: {
    latDms: [number, number, number];
    latRef: string;
    lonDms: [number, number, number];
    lonRef: string;
  };
  dateTimeOriginal?: string;
  bigEndian?: boolean;
  /** Emit the GPS/Exif IFDs but with a bogus pointer, to test robustness. */
  corruptPointer?: boolean;
}): Uint8Array {
  const little = !opts.bigEndian;
  const chunks: number[] = [];
  const tiff: number[] = [];

  const u16 = (arr: number[], v: number) => {
    if (little) arr.push(v & 0xff, (v >> 8) & 0xff);
    else arr.push((v >> 8) & 0xff, v & 0xff);
  };
  const u32 = (arr: number[], v: number) => {
    if (little) arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    else arr.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  };

  // TIFF header
  if (little) tiff.push(0x49, 0x49);
  else tiff.push(0x4d, 0x4d);
  u16(tiff, 0x002a);
  u32(tiff, 8); // IFD0 at offset 8

  const heap: number[] = [];
  const ifd0Count = (opts.gps ? 1 : 0) + (opts.dateTimeOriginal ? 1 : 0);
  // IFD0 starts at 8: 2 (count) + 12*n + 4 (next) → heap begins after.
  const ifd0Size = 2 + 12 * ifd0Count + 4;
  let heapBase = 8 + ifd0Size;

  // --- GPS IFD ---
  let gpsIfdOffset = 0;
  if (opts.gps) {
    const gpsEntryCount = 4;
    const gpsIfdSize = 2 + 12 * gpsEntryCount + 4;
    gpsIfdOffset = heapBase;
    const gpsHeapBase = gpsIfdOffset + gpsIfdSize;
    const gpsIfd: number[] = [];
    const gpsHeap: number[] = [];
    u16(gpsIfd, gpsEntryCount);

    // 0x0001 GPSLatitudeRef (ASCII, 2) — inline
    u16(gpsIfd, 0x0001);
    u16(gpsIfd, 2);
    u32(gpsIfd, 2);
    gpsIfd.push(opts.gps.latRef.charCodeAt(0), 0, 0, 0);
    // 0x0002 GPSLatitude (RATIONAL x3, 24 bytes) — heap
    u16(gpsIfd, 0x0002);
    u16(gpsIfd, 5);
    u32(gpsIfd, 3);
    u32(gpsIfd, gpsHeapBase + gpsHeap.length);
    for (const v of opts.gps.latDms) {
      u32(gpsHeap, Math.round(v * 10000));
      u32(gpsHeap, 10000);
    }
    // 0x0003 GPSLongitudeRef
    u16(gpsIfd, 0x0003);
    u16(gpsIfd, 2);
    u32(gpsIfd, 2);
    gpsIfd.push(opts.gps.lonRef.charCodeAt(0), 0, 0, 0);
    // 0x0004 GPSLongitude
    u16(gpsIfd, 0x0004);
    u16(gpsIfd, 5);
    u32(gpsIfd, 3);
    u32(gpsIfd, gpsHeapBase + gpsHeap.length);
    for (const v of opts.gps.lonDms) {
      u32(gpsHeap, Math.round(v * 10000));
      u32(gpsHeap, 10000);
    }

    u32(gpsIfd, 0); // next IFD
    heap.push(...gpsIfd, ...gpsHeap);
    heapBase = gpsHeapBase + gpsHeap.length;
  }

  // --- Exif IFD ---
  let exifIfdOffset = 0;
  if (opts.dateTimeOriginal) {
    const exifIfdSize = 2 + 12 * 1 + 4;
    exifIfdOffset = heapBase;
    const exifHeapBase = exifIfdOffset + exifIfdSize;
    const exifIfd: number[] = [];
    const exifHeap: number[] = [];
    u16(exifIfd, 1);
    const s = opts.dateTimeOriginal + "\0";
    u16(exifIfd, 0x9003);
    u16(exifIfd, 2);
    u32(exifIfd, s.length);
    u32(exifIfd, exifHeapBase);
    for (const ch of s) exifHeap.push(ch.charCodeAt(0));
    u32(exifIfd, 0);
    heap.push(...exifIfd, ...exifHeap);
    heapBase = exifHeapBase + exifHeap.length;
  }

  // IFD0
  const ifd0: number[] = [];
  u16(ifd0, ifd0Count);
  if (opts.dateTimeOriginal) {
    u16(ifd0, 0x8769);
    u16(ifd0, 4);
    u32(ifd0, 1);
    u32(ifd0, opts.corruptPointer ? 0x7fffffff : exifIfdOffset);
  }
  if (opts.gps) {
    u16(ifd0, 0x8825);
    u16(ifd0, 4);
    u32(ifd0, 1);
    u32(ifd0, opts.corruptPointer ? 0x7fffffff : gpsIfdOffset);
  }
  u32(ifd0, 0);

  tiff.push(...ifd0, ...heap);

  // JPEG wrapper: SOI + APP1("Exif\0\0" + tiff) + SOS
  chunks.push(0xff, 0xd8);
  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const segLen = app1Payload.length + 2;
  chunks.push(0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...app1Payload);
  chunks.push(0xff, 0xda, 0x00, 0x02); // SOS
  return new Uint8Array(chunks);
}

describe("parseExif", () => {
  it("extracts GPS and capture date from a real EXIF JPEG", () => {
    // Fryeburg Fairgrounds ≈ 44.0176 N, 70.9803 W
    const jpeg = buildJpegWithExif({
      gps: { latDms: [44, 1, 3.36], latRef: "N", lonDms: [70, 58, 49.08], lonRef: "W" },
      dateTimeOriginal: "2026:10:04 14:23:11",
    });
    const exif = parseExif(jpeg);
    expect(exif.gps).toBeDefined();
    expect(exif.gps!.latitude).toBeCloseTo(44.0176, 3);
    // W longitude must be negative.
    expect(exif.gps!.longitude).toBeCloseTo(-70.9803, 3);
    expect(exif.takenOnLocalDate).toBe("2026-10-04");
    expect(exif.takenAtLocalTime).toBe("14:23:11");
  });

  it("signs S/W hemispheres negative", () => {
    const jpeg = buildJpegWithExif({
      gps: { latDms: [33, 51, 54], latRef: "S", lonDms: [151, 12, 36], lonRef: "E" },
      dateTimeOriginal: "2026:01:02 03:04:05",
    });
    const exif = parseExif(jpeg);
    expect(exif.gps!.latitude).toBeLessThan(0); // Sydney, S
    expect(exif.gps!.longitude).toBeGreaterThan(0); // E stays positive
  });

  it("parses big-endian (MM) TIFF too", () => {
    const jpeg = buildJpegWithExif({
      gps: { latDms: [44, 0, 0], latRef: "N", lonDms: [70, 0, 0], lonRef: "W" },
      dateTimeOriginal: "2026:07:04 12:00:00",
      bigEndian: true,
    });
    const exif = parseExif(jpeg);
    expect(exif.gps!.latitude).toBeCloseTo(44, 5);
    expect(exif.takenOnLocalDate).toBe("2026-07-04");
  });

  it("returns date without GPS when the photo has no GPS IFD", () => {
    const jpeg = buildJpegWithExif({ dateTimeOriginal: "2026:08:23 09:00:00" });
    const exif = parseExif(jpeg);
    expect(exif.gps).toBeUndefined();
    expect(exif.takenOnLocalDate).toBe("2026-08-23");
  });

  it("treats a (0,0) fix as absent — Null Island is the 'GPS unset' sentinel", () => {
    const jpeg = buildJpegWithExif({
      gps: { latDms: [0, 0, 0], latRef: "N", lonDms: [0, 0, 0], lonRef: "E" },
      dateTimeOriginal: "2026:08:23 09:00:00",
    });
    expect(parseExif(jpeg).gps).toBeUndefined();
  });

  it("rejects the all-zero date placeholder", () => {
    const jpeg = buildJpegWithExif({ dateTimeOriginal: "0000:00:00 00:00:00" });
    expect(parseExif(jpeg).takenOnLocalDate).toBeUndefined();
  });

  // Every one of these must degrade to {} — a bad photo holds, never throws.
  it("returns empty (never throws) for non-JPEG and malformed input", () => {
    expect(parseExif(new Uint8Array([]))).toEqual({});
    expect(parseExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({}); // PNG
    expect(parseExif(new Uint8Array([0xff, 0xd8]))).toEqual({}); // SOI only
    expect(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]))).toEqual({});
    // HEIC (iPhone "High Efficiency") — expected miss, must not throw.
    const heic = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(parseExif(heic)).toEqual({});
  });

  it("survives a JPEG whose IFD pointers are garbage", () => {
    const jpeg = buildJpegWithExif({
      gps: { latDms: [44, 0, 0], latRef: "N", lonDms: [70, 0, 0], lonRef: "W" },
      dateTimeOriginal: "2026:07:04 12:00:00",
      corruptPointer: true,
    });
    expect(() => parseExif(jpeg)).not.toThrow();
    expect(parseExif(jpeg)).toEqual({});
  });

  it("ignores an APP1 that is XMP rather than EXIF", () => {
    // XMP also uses APP1; must not be mistaken for a TIFF header.
    const xmpNs = "http://ns.adobe.com/xap/1.0/\0";
    const payload = [...xmpNs].map((c) => c.charCodeAt(0));
    const segLen = payload.length + 2;
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe1,
      (segLen >> 8) & 0xff,
      segLen & 0xff,
      ...payload,
      0xff,
      0xda,
      0x00,
      0x02,
    ]);
    expect(parseExif(jpeg)).toEqual({});
  });
});
