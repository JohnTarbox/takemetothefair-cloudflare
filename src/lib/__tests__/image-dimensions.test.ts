import { describe, it, expect } from "vitest";
import { looksLikeLogo, parseImageDimensions } from "../image-dimensions";

// ---- PNG ----

function buildPng(width: number, height: number): Uint8Array {
  // Minimal valid PNG header up through IHDR width/height. Anything past
  // byte 24 isn't consulted by the parser.
  const bytes = new Uint8Array(24);
  // Signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk length (13) and type ("IHDR")
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  // Width and height (big-endian 32-bit)
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

// ---- JPEG ----

function buildJpeg(width: number, height: number): Uint8Array {
  // SOI + minimal SOF0 segment. No DQT/DHT/etc. before SOF — the parser
  // tolerates any marker order.
  const bytes = new Uint8Array(13);
  // SOI
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  // SOF0 marker
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  // Segment length (8 bytes after the length itself = total 10)
  bytes[4] = 0x00;
  bytes[5] = 0x0b;
  // Precision (8 bits)
  bytes[6] = 0x08;
  // Height (big-endian 16-bit)
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  // Width (big-endian 16-bit)
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  // Components count + minimal component spec (truncated; parser doesn't read it)
  bytes[11] = 0x01;
  bytes[12] = 0x00;
  return bytes;
}

// ---- WebP VP8X ----

function buildWebpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x00, 0x00, 0x00, 0x00], 4); // chunk size (ignored)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  bytes.set([0x00, 0x00, 0x00, 0x0a], 16); // chunk length (ignored)
  bytes.set([0x00, 0x00, 0x00, 0x00], 20); // flags (4 bytes)
  // Width-1 (24-bit LE) at offset 24
  const w = width - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  // Height-1 (24-bit LE) at offset 27
  const h = height - 1;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe("parseImageDimensions", () => {
  it("parses a 1200x800 PNG", () => {
    const r = parseImageDimensions(buildPng(1200, 800), "image/png");
    expect(r).toEqual({ width: 1200, height: 800 });
  });

  it("parses a 640x480 JPEG via SOF0 marker", () => {
    const r = parseImageDimensions(buildJpeg(640, 480), "image/jpeg");
    expect(r).toEqual({ width: 640, height: 480 });
  });

  it("parses a 1920x1080 WebP VP8X", () => {
    const r = parseImageDimensions(buildWebpVp8x(1920, 1080), "image/webp");
    expect(r).toEqual({ width: 1920, height: 1080 });
  });

  it("falls back to format sniffing when content-type is missing", () => {
    const r = parseImageDimensions(buildPng(500, 500), null);
    expect(r).toEqual({ width: 500, height: 500 });
  });

  it("returns null for non-image bytes", () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(parseImageDimensions(garbage, "image/png")).toBe(null);
    expect(parseImageDimensions(garbage, "image/jpeg")).toBe(null);
    expect(parseImageDimensions(garbage, "image/webp")).toBe(null);
  });

  it("returns null when bytes are too short", () => {
    expect(parseImageDimensions(new Uint8Array(4), "image/png")).toBe(null);
  });
});

describe("looksLikeLogo — Phase 2 down-rank heuristic", () => {
  it("flags filenames containing 'logo'", () => {
    const r = looksLikeLogo("https://example.com/site-logo.png", 1200, 800);
    expect(r).toEqual({ isLogo: true, reason: "url_contains_logo" });
  });

  it("flags case-insensitively (LOGO, Logo)", () => {
    expect(looksLikeLogo("https://e.com/LOGO.jpg", 1200, 800).isLogo).toBe(true);
    expect(looksLikeLogo("https://e.com/SiteLogo.png", 1200, 800).isLogo).toBe(true);
  });

  it("rejects images whose long edge is below 600px regardless of aspect", () => {
    const r = looksLikeLogo("https://example.com/event.png", 580, 320);
    expect(r.isLogo).toBe(true);
    if (r.isLogo) expect(r.reason).toMatch(/long_edge_below_600px/);
  });

  it("rejects small square images (logos commonly come in this shape)", () => {
    const r = looksLikeLogo("https://example.com/img.png", 300, 300);
    expect(r.isLogo).toBe(true);
    if (r.isLogo) expect(r.reason).toMatch(/small_square|long_edge/);
  });

  it("accepts a wide event photo at 1200x630", () => {
    const r = looksLikeLogo("https://example.com/event-hero.jpg", 1200, 630);
    expect(r).toEqual({ isLogo: false });
  });

  it("accepts a large square photo (1000x1000) — not a logo", () => {
    const r = looksLikeLogo("https://example.com/event-square.jpg", 1000, 1000);
    expect(r).toEqual({ isLogo: false });
  });

  it("flags small square even at 400x400 with no 'logo' in URL", () => {
    const r = looksLikeLogo("https://example.com/site-thumb.png", 400, 400);
    expect(r.isLogo).toBe(true);
  });
});
