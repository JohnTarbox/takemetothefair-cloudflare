/**
 * Pure header-byte parsers for JPEG / PNG / WebP image dimensions. Used by
 * og-image Phase 2 (analyst 2026-05-26) to replace the ~15KB content-length
 * proxy for "≥ 600px on long edge" with a real measurement.
 *
 * Each parser accepts a Uint8Array of at least the relevant header bytes
 * (~64 bytes for PNG/WebP, up to ~16KB for JPEG since SOF can sit deep
 * inside the file). Returns { width, height } in pixels or null on any
 * parse failure.
 *
 * No I/O — callers fetch a Range request and pass the bytes here. Keeps
 * the module testable without network mocks.
 */

/** Parse PNG dimensions. IHDR chunk follows the 8-byte signature; width is
 *  bytes 16-19, height is 20-23, both big-endian unsigned 32-bit. */
function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}

/** Parse JPEG dimensions. Walks the marker stream looking for an SOF (Start
 *  of Frame) marker — typically SOF0 (0xC0) for baseline, but the parser
 *  accepts the full SOFn range used by progressive/extended variants. */
function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4) return null;
  // SOI marker: 0xFF 0xD8
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let i = 2;
  while (i < bytes.length - 8) {
    // Each marker starts with 0xFF; padding 0xFF bytes are allowed.
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    // Skip padding 0xFF runs.
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) return null;
    const marker = bytes[i];
    i++;
    // Standalone markers carry no payload (e.g. RSTn 0xD0-0xD7, EOI 0xD9).
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue;
    }
    if (i + 2 > bytes.length) return null;
    const segmentLength = (bytes[i] << 8) | bytes[i + 1];
    // SOFn (Start of Frame): 0xC0-0xCF excluding 0xC4 (DHT), 0xC8 (JPG ext),
    // and 0xCC (DAC). Everything else in the range encodes frame metadata
    // with the same layout: [length][precision][height H][width W][...].
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // Layout: 2 bytes length, 1 byte precision, 2 bytes height, 2 bytes width
      if (i + 7 > bytes.length) return null;
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    // Skip past this segment to the next marker.
    i += segmentLength;
  }
  return null;
}

/** Parse WebP dimensions. WebP wraps one of three chunks inside the RIFF
 *  container: VP8 (lossy), VP8L (lossless), or VP8X (extended/animation). */
function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  // RIFF header: "RIFF" .... "WEBP"
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== "RIFF" || webp !== "WEBP") return null;

  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

  if (chunkType === "VP8X") {
    // VP8X extended: width-1 and height-1 each encoded as 24-bit LE at
    // offsets 24 and 27.
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunkType === "VP8L") {
    // VP8L lossless: 1 signature byte (0x2F) then 14 bits width-1 + 14 bits height-1.
    if (bytes[20] !== 0x2f) return null;
    const b21 = bytes[21];
    const b22 = bytes[22];
    const b23 = bytes[23];
    const b24 = bytes[24];
    const width = 1 + (b21 | ((b22 & 0x3f) << 8));
    const height = 1 + (((b22 >> 6) | (b23 << 2) | ((b24 & 0x0f) << 10)) & 0x3fff);
    return { width, height };
  }
  if (chunkType === "VP8 ") {
    // VP8 lossy: 3 bytes frame tag, then 0x9D 0x01 0x2A signature at offset
    // 23-25, then 16-bit LE width and height (with 2-bit scale in top 2 bits).
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }
  return null;
}

export function parseImageDimensions(
  bytes: Uint8Array,
  contentType: string | null
): { width: number; height: number } | null {
  const ct = (contentType ?? "").toLowerCase();
  // Try the content-type-implied parser first; fall through to format
  // sniffing on failure (the CDN may have mislabeled or content-type may
  // be missing entirely).
  if (ct.includes("png")) return parsePngDimensions(bytes);
  if (ct.includes("jpeg") || ct.includes("jpg")) return parseJpegDimensions(bytes);
  if (ct.includes("webp")) return parseWebpDimensions(bytes);
  // Format sniff fallback.
  return parsePngDimensions(bytes) ?? parseJpegDimensions(bytes) ?? parseWebpDimensions(bytes);
}

/** Logo down-rank heuristic. Returns true when the image looks like a brand
 *  logo rather than event photography. Triggers:
 *   - filename contains "logo" (case-insensitive)
 *   - small square aspect (≤ 400px each side, ratio between 0.8 and 1.25)
 *   - long edge < 600px (the minimum we'd accept anyway)
 *
 *  Used after dimensions are known. The og-image accept gate already
 *  excludes SVGs since most are logos; this catches the raster cases the
 *  SVG filter misses (Squarespace/Wix org sites that ship PNG logos as
 *  their og:image).
 */
export function looksLikeLogo(
  url: string,
  width: number,
  height: number
): { isLogo: true; reason: string } | { isLogo: false } {
  if (/logo/i.test(url)) {
    return { isLogo: true, reason: "url_contains_logo" };
  }
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long < 600) {
    return { isLogo: true, reason: `long_edge_below_600px (${long}px)` };
  }
  const ratio = short / long;
  if (ratio >= 0.8 && long <= 400) {
    return { isLogo: true, reason: `small_square (${width}x${height})` };
  }
  return { isLogo: false };
}
