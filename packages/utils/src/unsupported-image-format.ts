/**
 * OPE-1550 — name the image format we refuse, so a refusal is never anonymous.
 *
 * Every MMATF intake gate decides what an image IS from its magic bytes, and each
 * one allows only JPEG / PNG / WebP (+ SVG on the admin pipeline, + GIF / HEIC /
 * PDF on inbound mail). Before this, a file outside that set was refused with
 * "File bytes don't match any supported image format", which tells a vendor
 * holding a perfectly good photo nothing about what to do.
 *
 * JPEG XL is the case that prompted this: Chrome 155 and Firefox 158 now open
 * `.jxl` natively, so people will save and upload them without noticing. We can't
 * convert one at ingest — Cloudflare image transformations don't accept JXL as an
 * INPUT format (inputs: PNG, JPEG, GIF, WebP, SVG, HEIC, AVIF on Enterprise only;
 * developers.cloudflare.com/images/get-started/limits/, read 2026-11-01) — so the
 * honest answer is a refusal that says which format it was and what to send instead.
 *
 * This is a NAMER, not an allow-list. It never says a file is acceptable; callers
 * keep their own allow-lists and only consult this once a file has been refused.
 */

export interface UnsupportedImageFormat {
  /** IANA-style MIME type, e.g. "image/jxl". */
  mime: string;
  /** Human name for the error message, e.g. "JPEG XL (.jxl)". */
  label: string;
}

const ascii = (b: Uint8Array, start: number, len: number): string => {
  if (b.byteLength < start + len) return "";
  let s = "";
  for (let i = start; i < start + len; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** ISO/IEC 18181-2 container signature: a 12-byte `JXL ` box. */
const JXL_CONTAINER = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

export const JPEG_XL: UnsupportedImageFormat = { mime: "image/jxl", label: "JPEG XL (.jxl)" };

/**
 * Identify a recognisable image format that MMATF does not accept.
 * Returns null for anything it does not recognise — including the formats we DO
 * accept, which callers have already matched before reaching here.
 */
export function identifyUnsupportedImageFormat(bytes: Uint8Array): UnsupportedImageFormat | null {
  const b = bytes;
  if (b.byteLength < 2) return null;
  // JPEG XL bare codestream (ISO/IEC 18181-1): FF 0A. Distinct from JPEG's FF D8.
  if (b[0] === 0xff && b[1] === 0x0a) return JPEG_XL;
  if (b.byteLength >= JXL_CONTAINER.length && JXL_CONTAINER.every((v, i) => b[i] === v)) {
    return JPEG_XL;
  }
  if (ascii(b, 4, 4) === "ftyp") {
    const major = ascii(b, 8, 4);
    if (major === "avif" || major === "avis") return { mime: "image/avif", label: "AVIF (.avif)" };
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"].includes(major)) {
      return { mime: "image/heic", label: "HEIC/HEIF (.heic)" };
    }
  }
  const tiff = ascii(b, 0, 4);
  if (tiff === "II*\u0000" || tiff === "MM\u0000*")
    return { mime: "image/tiff", label: "TIFF (.tif)" };
  if (ascii(b, 0, 2) === "BM" && b.byteLength >= 14)
    return { mime: "image/bmp", label: "BMP (.bmp)" };
  return null;
}

/** Map a declared MIME type (from a browser or a sender) to a known unsupported format. */
export function unsupportedImageFormatForMime(mime: string): UnsupportedImageFormat | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m === "image/jxl") return JPEG_XL;
  if (m === "image/avif") return { mime: m, label: "AVIF (.avif)" };
  if (m === "image/heic" || m === "image/heif") return { mime: m, label: "HEIC/HEIF (.heic)" };
  if (m === "image/tiff") return { mime: m, label: "TIFF (.tif)" };
  if (m === "image/bmp") return { mime: m, label: "BMP (.bmp)" };
  return null;
}

/** The refusal text every upload path shares, so the advice is the same everywhere. */
export function unsupportedImageMessage(
  format: UnsupportedImageFormat,
  accepted = "JPEG, PNG or WebP"
): string {
  return `${format.label} images aren't supported yet. Please save the image as ${accepted} and upload it again.`;
}
