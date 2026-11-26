import { describe, it, expect } from "vitest";
import {
  eventDocumentExpiresAt,
  eventDocumentProvenance,
  eventDocumentTypeAndSize,
  isEventDocumentLive,
  isEventDocumentMimeType,
  stripPngMetadata,
} from "./event-documents";

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [
    (len >>> 24) & 255,
    (len >>> 16) & 255,
    (len >>> 8) & 255,
    len & 255,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("stripPngMetadata", () => {
  const png = new Uint8Array([
    ...SIG,
    ...chunk("IHDR", [1, 2, 3]),
    ...chunk("tEXt", text("Author\0Reese")),
    ...chunk("eXIf", [9, 9]),
    ...chunk("IDAT", [7, 7, 7]),
    ...chunk("tIME", [1]),
    ...chunk("IEND", []),
  ]);

  it("removes text, EXIF and time chunks and keeps the image", () => {
    const { bytes, chunksRemoved } = stripPngMetadata(png);
    expect(chunksRemoved).toBe(3);
    expect(Array.from(bytes)).toEqual([
      ...SIG,
      ...chunk("IHDR", [1, 2, 3]),
      ...chunk("IDAT", [7, 7, 7]),
      ...chunk("IEND", []),
    ]);
  });

  it("leaves a truncated PNG untouched rather than rewriting it", () => {
    const cut = png.subarray(0, png.length - 6);
    expect(stripPngMetadata(cut)).toEqual({ bytes: cut, chunksRemoved: 0 });
  });

  it("leaves a non-PNG untouched", () => {
    const pdf = new Uint8Array(text("%PDF-1.4 and some more bytes"));
    expect(stripPngMetadata(pdf).bytes).toBe(pdf);
  });
});

describe("event document rules", () => {
  it("expires after the event's end date", () => {
    expect(eventDocumentExpiresAt(new Date("2026-12-05T12:00:00Z")).toISOString()).toBe(
      "2026-12-06T12:00:00.000Z"
    );
  });

  it("is live only while status is live and it has not expired", () => {
    const expiresAt = new Date("2026-12-06T12:00:00Z");
    const before = new Date("2026-12-06T11:59:00Z");
    const after = new Date("2026-12-06T12:01:00Z");
    expect(isEventDocumentLive({ status: "live", expiresAt }, before)).toBe(true);
    expect(isEventDocumentLive({ status: "live", expiresAt }, after)).toBe(false);
    expect(isEventDocumentLive({ status: "withdrawn", expiresAt }, before)).toBe(false);
  });

  it("allows only PDF, PNG and JPEG", () => {
    expect(isEventDocumentMimeType("application/pdf")).toBe(true);
    expect(isEventDocumentMimeType("image/webp")).toBe(false);
    expect(isEventDocumentMimeType(null)).toBe(false);
  });

  it("formats the public lines", () => {
    expect(
      eventDocumentProvenance("UMF Conferences and Events", new Date("2026-09-12T01:20:41Z"))
    ).toBe("Received from UMF Conferences and Events, September 2026");
    expect(eventDocumentTypeAndSize("application/pdf", 404_786)).toBe("PDF, 395 KB");
    expect(eventDocumentTypeAndSize("image/png", 2_097_152)).toBe("PNG, 2.0 MB");
  });
});
