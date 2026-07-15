import { describe, expect, it } from "vitest";

import { detectMagicBytes, resolveImageTarget } from "../upload-image-pipeline";

/**
 * Unit tests for the pure magic-byte sniff. The full runUploadPipeline
 * depends on R2, D1, and Cloudflare Image Resizing — those paths are
 * exercised through the existing upload_image_bytes MCP tool in prod
 * (behavior-parity refactor; no separate integration suite). Magic-byte
 * detection is the one piece worth pinning here because the K17 work
 * extracted it from a route handler into a shared module.
 */
describe("detectMagicBytes", () => {
  function bytesOf(...vals: number[]): Uint8Array {
    return new Uint8Array(vals);
  }

  it("detects JPEG by FF D8 FF prefix", () => {
    expect(detectMagicBytes(bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
  });

  it("detects PNG by 89 50 4E 47 prefix", () => {
    expect(detectMagicBytes(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      "image/png"
    );
  });

  it("detects WebP by RIFF + WEBP signature", () => {
    expect(
      detectMagicBytes(
        bytesOf(
          0x52,
          0x49,
          0x46,
          0x46, // RIFF
          0x00,
          0x00,
          0x00,
          0x00, // size (ignored)
          0x57,
          0x45,
          0x42,
          0x50 // WEBP
        )
      )
    ).toBe("image/webp");
  });

  it("does not match RIFF without WEBP signature", () => {
    expect(
      detectMagicBytes(
        bytesOf(
          0x52,
          0x49,
          0x46,
          0x46, // RIFF
          0x00,
          0x00,
          0x00,
          0x00,
          0x57,
          0x41,
          0x56,
          0x45 // WAVE — not WEBP
        )
      )
    ).toBe(null);
  });

  it("detects SVG via direct <svg tag", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectMagicBytes(svg)).toBe("image/svg+xml");
  });

  it("detects SVG via XML prolog followed by <svg later", () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    );
    expect(detectMagicBytes(svg)).toBe("image/svg+xml");
  });

  it("detects SVG even when leading whitespace precedes the < character", () => {
    const svg = new TextEncoder().encode("   \n\t<svg></svg>");
    expect(detectMagicBytes(svg)).toBe("image/svg+xml");
  });

  it("returns null for the declared-jpeg-but-actually-text attack", () => {
    // The exact "<svg> claiming image/jpeg" attack from the original
    // route handler's comment — neither route nor pipeline accepts it.
    const textAsImage = new TextEncoder().encode("just plain text, not an image");
    expect(detectMagicBytes(textAsImage)).toBe(null);
  });

  it("returns null for empty / too-short buffers", () => {
    expect(detectMagicBytes(new Uint8Array(0))).toBe(null);
    expect(detectMagicBytes(bytesOf(0xff))).toBe(null);
    expect(detectMagicBytes(bytesOf(0xff, 0xd8))).toBe(null);
  });

  it("returns null for unknown binary signatures", () => {
    // GIF (47 49 46 38) is not in the allowlist — pipeline returns null.
    expect(detectMagicBytes(bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(null);
  });

  it("treats SVG-like bytes followed by binary content the same as text-only SVG", () => {
    // Conservative behavior: only the first 256 bytes are sniffed for
    // <svg, so a long binary file that happens to start with whitespace
    // and < isn't misclassified.
    const buf = new Uint8Array(64);
    buf[0] = 0x3c; // '<'
    buf[1] = 0xff; // not a valid SVG continuation
    expect(detectMagicBytes(buf)).toBe(null);
  });
});

/**
 * OPE-211 — the role→destination dispatch. Extracted from runUploadPipeline
 * specifically so it can be tested: the pipeline itself needs R2 + D1 + CF
 * Image Resizing, and this decision is where a mistake is silent (a mis-routed
 * role overwrites a live column instead of erroring).
 */
describe("resolveImageTarget", () => {
  const ok = (
    t: Parameters<typeof resolveImageTarget>[0],
    r: Parameters<typeof resolveImageTarget>[1]
  ) => {
    const res = resolveImageTarget(t, r);
    if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`);
    return res.target;
  };

  it("routes a gallery upload to a row, not a column", () => {
    // The whole point: no column is touched, so the vendor's brand logo and the
    // event's hero both survive an added gallery photo.
    for (const t of ["vendor", "event"] as const) {
      expect(ok(t, "gallery").isGallery).toBe(true);
      expect(ok(t, "gallery").imageColumn).toBeNull();
    }
  });

  it("keeps gallery objects away from the logo key", () => {
    // vendors/<id>/photos/photo-<ts> vs vendors/<id>/logo-<ts> — a gallery
    // upload must never collide with, or be mistaken for, the single logo.
    expect(ok("vendor", "gallery").fileKind).toBe("photos/photo");
    expect(ok("vendor", "logo").fileKind).toBe("logo");
    expect(ok("vendor", "gallery").keyPrefix).toBe("vendors");
  });

  it("refuses a gallery upload for a target with no gallery table", () => {
    // venue/promoter have no *_photos table — refusing loudly beats silently
    // clobbering their single image column.
    for (const t of ["venue", "promoter"] as const) {
      const res = resolveImageTarget(t, "gallery");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("only supported for target_type");
    }
  });

  it("keeps event gallery objects away from the hero key (OPE-212)", () => {
    // events/<id>/photos/photo-<ts> vs events/<id>/image-<ts>.
    expect(ok("event", "gallery").keyPrefix).toBe("events");
    expect(ok("event", "gallery").fileKind).toBe("photos/photo");
    expect(ok("event", "logo").fileKind).toBe("image");
  });

  it("leaves every pre-OPE-211 route unchanged", () => {
    expect(ok("vendor", "logo").imageColumn).toBe("logoUrl");
    expect(ok("promoter", "logo").imageColumn).toBe("logoUrl");
    expect(ok("promoter", "hero").imageColumn).toBe("heroImageUrl");
    expect(ok("event", "logo").imageColumn).toBe("imageUrl");
    expect(ok("venue", "logo").imageColumn).toBe("imageUrl");
    // Promoter key kind still tracks the role (OPE-33).
    expect(ok("promoter", "hero").fileKind).toBe("hero");
    expect(ok("event", "logo").fileKind).toBe("image");
    expect(ok("event", "logo").keyPrefix).toBe("events");
    expect(ok("venue", "logo").keyPrefix).toBe("venues");
    expect(ok("promoter", "logo").keyPrefix).toBe("promoters");
  });

  it("never routes a non-gallery upload to the gallery", () => {
    for (const t of ["event", "vendor", "venue", "promoter"] as const) {
      for (const r of ["logo", "hero"] as const) {
        expect(ok(t, r).isGallery).toBe(false);
        expect(ok(t, r).imageColumn).not.toBeNull();
      }
    }
  });
});
