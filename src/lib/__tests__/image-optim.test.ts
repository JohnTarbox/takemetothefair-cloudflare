import { describe, it, expect } from "vitest";
import { stripExifFromJpeg, SOFT_SIZE_LIMIT_BYTES } from "../image-optim";

// JPEG segment markers used in the test fixtures.
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/** Build a JPEG segment: marker + 2-byte big-endian length + payload. */
function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

/** Minimal JPEG-shaped buffer with an APP1 EXIF segment, a SOS+scan,
 *  and an EOI. Not a decodable image; just enough structure to exercise
 *  the segment walker. */
function jpegWithSegments(...segs: number[][]): Uint8Array {
  return new Uint8Array([
    ...SOI,
    ...segs.flat(),
    // SOS marker + minimal "scan data" (one byte, no stuffing) + EOI
    ...segment(0xda, [0x00, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    0x42, // one scan byte
    ...EOI,
  ]);
}

describe("stripExifFromJpeg", () => {
  it("removes an APP1 (EXIF) segment", () => {
    // APP1 starts with the 'Exif\0\0' identifier; we use placeholder bytes
    // because the stripper doesn't inspect content — it strips any APP1.
    const exifPayload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04];
    const input = jpegWithSegments(segment(0xe1, exifPayload));
    const { bytes, segmentsStripped, bytesRemoved } = stripExifFromJpeg(input);
    expect(segmentsStripped).toBe(1);
    expect(bytesRemoved).toBe(exifPayload.length + 4); // payload + marker + length bytes
    expect(bytes.length).toBe(input.length - bytesRemoved);
    // Verify the EOI is still present
    expect(bytes[bytes.length - 2]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
  });

  it("removes APP0 (JFIF) and APP2 (ICC) alongside EXIF", () => {
    const app0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00]);
    const app1 = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff]);
    const app2 = segment(0xe2, [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46]);
    const input = jpegWithSegments(app0, app1, app2);
    const { segmentsStripped } = stripExifFromJpeg(input);
    expect(segmentsStripped).toBe(3);
  });

  it("keeps DQT (quantization table) and other structural segments", () => {
    const dqt = segment(
      0xdb,
      Array.from({ length: 65 }, (_, i) => i)
    );
    const exif = segment(0xe1, [0x01, 0x02, 0x03, 0x04]);
    const input = jpegWithSegments(dqt, exif);
    const { bytes, segmentsStripped } = stripExifFromJpeg(input);
    expect(segmentsStripped).toBe(1);
    // DQT bytes should still be in the output
    const dqtStart = 2; // after SOI
    expect(bytes[dqtStart]).toBe(0xff);
    expect(bytes[dqtStart + 1]).toBe(0xdb);
  });

  it("returns input unchanged for non-JPEG bytes", () => {
    // PNG signature
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { bytes, segmentsStripped, bytesRemoved } = stripExifFromJpeg(png);
    expect(bytes).toBe(png);
    expect(segmentsStripped).toBe(0);
    expect(bytesRemoved).toBe(0);
  });

  it("passes through a JPEG with no APP segments", () => {
    const dqt = segment(0xdb, [0x00, 0x10]);
    const input = jpegWithSegments(dqt);
    const { bytes, segmentsStripped } = stripExifFromJpeg(input);
    expect(segmentsStripped).toBe(0);
    expect(bytes.length).toBe(input.length);
  });

  it("survives a stuffed 0xFF in scan data without truncating", () => {
    // Build a JPEG where scan data contains 0xFF 0x00 (a stuffed byte
    // representing a literal 0xFF in the entropy-coded stream). The
    // stripper must not interpret this as a marker.
    const buf = new Uint8Array([
      ...SOI,
      ...segment(0xe1, [0xaa]), // APP1 to strip
      // SOS
      ...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
      // scan data with a stuffed 0xFF
      0x42,
      0xff,
      0x00, // literal 0xFF in scan data
      0x43,
      ...EOI,
    ]);
    const { bytes, segmentsStripped } = stripExifFromJpeg(buf);
    expect(segmentsStripped).toBe(1);
    // Scan data plus EOI must still be present
    const eoi = bytes[bytes.length - 1];
    const beforeEoi = bytes[bytes.length - 2];
    expect(beforeEoi).toBe(0xff);
    expect(eoi).toBe(0xd9);
    // The 0xFF 0x00 stuffed sequence must survive
    let foundStuffed = false;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) {
        foundStuffed = true;
        break;
      }
    }
    expect(foundStuffed).toBe(true);
  });

  it("returns input on a malformed JPEG rather than corrupting it", () => {
    // SOI followed by a non-0xFF byte — invalid.
    const bad = new Uint8Array([0xff, 0xd8, 0x42, 0x42]);
    const { bytes, segmentsStripped } = stripExifFromJpeg(bad);
    // Walker bails after the SOI when it can't find a marker, returns the
    // input. The bytes pointer should be the original.
    expect(bytes).toBe(bad);
    expect(segmentsStripped).toBe(0);
  });
});

describe("SOFT_SIZE_LIMIT_BYTES", () => {
  it("targets ~1MB for CDN-served images", () => {
    expect(SOFT_SIZE_LIMIT_BYTES).toBe(1024 * 1024);
  });
});
