import { describe, it, expect } from "vitest";
import { parseExif } from "../src/photo/exif.js";
import { buildJpegWithExif } from "./helpers/exif-jpeg.js";

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
