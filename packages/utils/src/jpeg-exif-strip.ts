/**
 * JPEG metadata strip — the gate for anything promoted to the public CDN.
 *
 * Moved here from `src/lib/image-optim.ts` (OPE-1341) so the MCP Worker's
 * snap-intake route strips with the SAME code the main app's upload pipeline
 * uses, instead of a second copy that could drift. `src/lib/image-optim.ts`
 * re-exports it, so every existing import is unchanged.
 *
 *   - JPEG: walk segment markers, drop APP0/APP1/APP2/APP13/APP14/COM (EXIF
 *     and its GPS live in APP1). Keeps SOI, SOFx, DQT, DHT, SOS + scan data.
 *   - Anything else: passthrough.
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
