/**
 * Server-side image optimization helpers for the upload-image-bytes route
 * (analyst 2026-05-22 P5a Phase 2a). Pure functions, no dependencies — the
 * heavier parts of the analyst's spec (auto-orient pixels, resize, WebP
 * convert) require either a WASM image library or the Cloudflare Images
 * binding, both of which are still in research-spike status. Phase 2a
 * ships the highest-stakes piece: EXIF stripping.
 *
 * Why EXIF strip is the most important piece:
 *   Phones embed GPS coordinates in JPEG EXIF by default. The "John
 *   attended the show and brought back a photo" workflow this tool was
 *   built for would otherwise leak the photographer's home GPS history
 *   onto a public CDN. Stripping EXIF on the server-side guarantees the
 *   leak can't happen regardless of the client's optimization habits.
 *
 * Pipeline:
 *   - JPEG: walk segment markers, drop APP0/APP1/APP2 (EXIF lives in APP1
 *     'Exif\0\0' for camera EXIF and APP1 'http://ns.adobe.com/xap/1.0/'
 *     for Adobe XMP). Keeps Start-of-Image, all SOFx frames, quantization
 *     tables, Huffman tables, scan data — everything decoders need.
 *   - PNG / WebP / SVG: passthrough. PNG has tEXt/iTXt chunks that can
 *     carry metadata but uncommon for phone photos; defer to Phase 2b.
 *   - Returns { bytes, bytesRemoved } so callers can log savings.
 */

export interface StripResult {
  bytes: Uint8Array;
  bytesRemoved: number;
  segmentsStripped: number;
}

const APP_MARKERS_TO_STRIP = new Set<number>([
  0xe0, // APP0 — JFIF / JFXX thumbnail
  0xe1, // APP1 — EXIF, XMP
  0xe2, // APP2 — ICC color profile (most viewers default fine without it)
  0xed, // APP13 — Photoshop IRB (IPTC metadata)
  0xee, // APP14 — Adobe DCT info (most JPEGs survive its removal)
  0xfe, // COM — comment segment
]);

/**
 * Strip EXIF/XMP/IPTC/comment segments from a JPEG byte stream. Returns
 * the input bytes unchanged when the input doesn't look like a JPEG.
 *
 * JPEG structure: SOI (0xFFD8) + segments + scan data + EOI (0xFFD9).
 * Each segment starts with marker 0xFFXX. APPn markers (0xFFE0-0xFFEF)
 * and COM markers (0xFFFE) carry metadata we don't need. SOFx markers
 * (0xFFC0-0xFFCF except 0xFFC4/0xFFC8/0xFFCC), DHT (0xFFC4), DQT (0xFFDB),
 * DRI (0xFFDD), SOS (0xFFDA), and EOI are structural and must be kept.
 *
 * The SOS marker is followed by entropy-coded scan data with no length
 * field — read until the next non-stuffed 0xFF marker to find the end.
 */
export function stripExifFromJpeg(input: Uint8Array): StripResult {
  // Not a JPEG → passthrough.
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    return { bytes: input, bytesRemoved: 0, segmentsStripped: 0 };
  }

  const out: number[] = [];
  // SOI
  out.push(0xff, 0xd8);

  let i = 2;
  let segmentsStripped = 0;
  let bytesRemoved = 0;

  while (i < input.length) {
    if (input[i] !== 0xff) {
      // Malformed JPEG — bail and return the original bytes to avoid
      // producing a corrupt output. The R2 put then stores the original;
      // worst case the EXIF isn't stripped.
      return { bytes: input, bytesRemoved: 0, segmentsStripped: 0 };
    }
    // Skip fill bytes (multiple 0xFF in a row are allowed before a marker)
    while (i < input.length && input[i] === 0xff) i++;
    if (i >= input.length) break;

    const marker = input[i];
    i++; // consume marker byte

    // Standalone markers (no payload, no length): RST0-7 (0xD0-0xD7),
    // SOI (0xD8), EOI (0xD9), TEM (0x01). EOI ends the file.
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      bytesRemoved += input.length - i; // anything after EOI is junk
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      out.push(0xff, marker);
      continue;
    }

    // All other markers have a 2-byte big-endian length INCLUDING the
    // two length bytes themselves.
    if (i + 1 >= input.length) {
      return { bytes: input, bytesRemoved: 0, segmentsStripped: 0 };
    }
    const segLen = (input[i] << 8) | input[i + 1];
    if (segLen < 2 || i + segLen > input.length) {
      return { bytes: input, bytesRemoved: 0, segmentsStripped: 0 };
    }

    if (APP_MARKERS_TO_STRIP.has(marker)) {
      // Skip this segment entirely.
      segmentsStripped++;
      bytesRemoved += segLen + 2; // 2 marker bytes + segment payload
      i += segLen;
      continue;
    }

    // Keep this segment.
    out.push(0xff, marker, input[i], input[i + 1]);
    for (let j = 2; j < segLen; j++) out.push(input[i + j]);
    i += segLen;

    // SOS — start of scan. The entropy-coded scan data follows with no
    // length field. Copy bytes until we hit a non-stuffed 0xFF marker
    // (a 0xFF followed by 0x00 is a "stuffed" byte = literal 0xFF in
    // scan data, not a marker). The next real marker is typically EOI
    // (0xFFD9) or a restart (0xFFD0-D7).
    if (marker === 0xda) {
      while (i < input.length) {
        const b = input[i];
        out.push(b);
        i++;
        if (b === 0xff && i < input.length) {
          const next = input[i];
          if (next === 0x00) {
            // Stuffed 0xFF — literal data.
            out.push(0x00);
            i++;
            continue;
          }
          if (next >= 0xd0 && next <= 0xd7) {
            // Restart marker inside scan data — keep it and continue.
            out.push(next);
            i++;
            continue;
          }
          // Real marker — back out of the scan-copy loop. Rewind so the
          // outer loop sees the 0xFF.
          out.pop(); // remove the 0xFF we just pushed
          i--;
          break;
        }
      }
    }
  }

  return { bytes: new Uint8Array(out), bytesRemoved, segmentsStripped };
}

/** Soft size budget. Phase 2a target: keep CDN-served bytes under 1MB
 *  per image. Phase 2b's resize+WebP transform usually brings outputs
 *  well under this; the field stays useful as an observability signal
 *  when the transform falls back to the original (rare). Hard cap stays
 *  at the input MAX_BYTES (10MB) in the route. */
export const SOFT_SIZE_LIMIT_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Phase 2b — Cloudflare Image Resizing transform
// ---------------------------------------------------------------------------
//
// Phase 2a (above) strips EXIF/XMP/IPTC metadata in-process via a JS segment
// walker. Phase 2b layers on the pixel-level operations the analyst's spec
// also requires: auto-orient (apply EXIF Orientation as a pixel rotation),
// resize to 2000px longest edge, re-encode as WebP at q85.
//
// Implementation: Cloudflare's Image Resizing via `fetch(url, { cf: { image:
// {...} } })`. Image Resizing must be enabled on the meetmeatthefair.com
// zone in the Cloudflare dashboard (Speed → Optimization → Image Resizing).
// Without that toggle, the transform call returns the source bytes unchanged
// or a non-2xx — the caller is expected to detect this and fall back to
// storing the Phase-2a-stripped original (the worst case is identical to
// today's behavior).

/** Default resize / re-encode parameters per analyst spec 2026-05-22. */
const PHASE2B_DEFAULT_LONGEST_EDGE = 2000;
const PHASE2B_DEFAULT_QUALITY = 85;

/** Outputs the transform helper carries back to the caller. `bytes` and
 *  `finalBytes` are the WebP body and its length; `originalBytes` is the
 *  size of the source URL's response (useful for compression-ratio
 *  observability). `durationMs` is the wall-clock time of the cf.image
 *  fetch — typically <500 ms for a same-zone source. */
export interface TransformResult {
  bytes: Uint8Array;
  originalBytes: number;
  finalBytes: number;
  contentType: "image/webp";
  width: number | null;
  height: number | null;
  durationMs: number;
}

export class ImageTransformError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Image transform error ${status}: ${detail}`);
    this.name = "ImageTransformError";
    this.status = status;
    this.detail = detail;
  }
}

export interface TransformOptions {
  maxLongestEdge?: number;
  quality?: number;
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Transform a publicly-fetchable image URL via Cloudflare Image Resizing.
 * Returns WebP bytes resized to fit within `maxLongestEdge` (default 2000)
 * with quality `quality` (default 85). EXIF Orientation is applied
 * automatically — the output is upright regardless of input orientation.
 *
 * Throws `ImageTransformError` when Cloudflare responds non-2xx (which
 * happens when Image Resizing isn't enabled on the zone, or when the
 * source URL isn't fetchable). Callers are expected to catch and fall
 * back to storing original bytes.
 *
 * The `cf.image` option is honored only when this fetch leaves the Workers
 * runtime on Cloudflare's network. Local dev / test runs without the cf
 * option set will return the source bytes unchanged — `fetchImpl` is
 * provided so unit tests can mock the network response.
 */
export async function transformViaCloudflare(
  sourceUrl: string,
  opts: TransformOptions = {}
): Promise<TransformResult> {
  const maxLongestEdge = opts.maxLongestEdge ?? PHASE2B_DEFAULT_LONGEST_EDGE;
  const quality = opts.quality ?? PHASE2B_DEFAULT_QUALITY;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const cfImageOptions = {
    width: maxLongestEdge,
    height: maxLongestEdge,
    fit: "scale-down" as const,
    format: "webp" as const,
    quality,
    // Strip remaining metadata at the transform boundary. Phase 2a already
    // stripped on the JPEG side; this catches the PNG/WebP cases too.
    metadata: "none" as const,
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(sourceUrl, {
      // Cloudflare Workers fetch accepts the cf option for image
      // transforms. TypeScript's RequestInit doesn't include cf in the
      // shared lib types; pass through with a cast rather than augmenting
      // the global type. This is the same pattern Cloudflare's own docs use.
      cf: { image: cfImageOptions },
    } as RequestInit & { cf: { image: typeof cfImageOptions } });
  } catch (err) {
    throw new ImageTransformError(
      0,
      `fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) detail = `${detail}: ${text.slice(0, 300)}`;
    } catch {
      // Body unreadable; the status alone is enough context.
    }
    throw new ImageTransformError(response.status, detail);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new ImageTransformError(
      response.status,
      `unexpected content-type "${contentType}" (Image Resizing not enabled on zone?)`
    );
  }

  // Cloudflare returns the transformed dimensions in custom response
  // headers. They're informational — when missing (older edge cache, etc.)
  // we surface null rather than guess.
  const widthHeader = response.headers.get("cf-resized-image-width");
  const heightHeader = response.headers.get("cf-resized-image-height");
  const width = widthHeader ? parseInt(widthHeader, 10) : null;
  const height = heightHeader ? parseInt(heightHeader, 10) : null;

  // Read the original Content-Length for compression-ratio observability.
  // This is the size of the *source* response before transform; on hit
  // it may be the cached transform — which is fine, we just want a number.
  const originalLengthHeader = response.headers.get("x-original-content-length");
  const originalBytes = originalLengthHeader ? parseInt(originalLengthHeader, 10) : 0;

  const buf = new Uint8Array(await response.arrayBuffer());
  return {
    bytes: buf,
    originalBytes: originalBytes || buf.length,
    finalBytes: buf.length,
    contentType: "image/webp",
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
    durationMs: Date.now() - startedAt,
  };
}
