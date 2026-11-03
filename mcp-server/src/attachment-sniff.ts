/**
 * OPE-1364 — decide what an inbound attachment IS from its bytes, never from
 * the sender's declared MIME type.
 *
 * Inbound attachments are stored on the bucket behind `cdn.meetmeatthefair.com`
 * (same-site with the apex), and R2 serves an object under the content type it
 * was stored with. Before this, that was the sender's declared type, and the
 * capture gate was `startsWith("image/")` — so an `image/svg+xml` part (an
 * image type that runs script) went to the CDN as first-party active content.
 *
 * Only the formats the pipeline actually consumes are recognised. Anything
 * else — SVG, HTML, TIFF, AVIF, a mislabelled .docx — returns null and the
 * caller refuses it. The returned type is what gets stored and recorded in
 * `attachment_refs[].mimeType`, so every downstream reader (OCR, poster hero,
 * photo intake, the admin viewer) sees the sniffed type too.
 */
export type SniffedAttachmentType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "application/pdf";

const ascii = (b: Uint8Array, start: number, len: number): string => {
  if (b.byteLength < start + len) return "";
  let s = "";
  for (let i = start; i < start + len; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** ISO-BMFF brands that mean an HEVC-coded HEIF image (what iPhones send). */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
/** Generic HEIF brands — an image container whose codec the brand doesn't name. */
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);
/** AVIF shares the HEIF container (and lists mif1); it is not on the allow-list. */
const AVIF_BRANDS = new Set(["avif", "avis"]);

function sniffIsoBmff(b: Uint8Array): SniffedAttachmentType | null {
  if (ascii(b, 4, 4) !== "ftyp") return null;
  const boxSize = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const major = ascii(b, 8, 4);
  // Compatible brands follow the 4-byte minor version, up to the box end.
  const end = Math.min(boxSize >= 16 ? boxSize : 16, b.byteLength, 256);
  const brands = [major];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(b, o, 4));
  if (AVIF_BRANDS.has(major)) return null;
  if (brands.some((x) => HEIC_BRANDS.has(x))) return "image/heic";
  if (brands.some((x) => HEIF_BRANDS.has(x))) return "image/heif";
  return null;
}

/** How far into a file a PDF header may sit. The PDF spec tolerates leading
 *  junk and readers search the first KB; real mail PDFs start at 0. */
const PDF_HEADER_WINDOW = 1024;

export function sniffAttachmentType(bytes: Uint8Array): SniffedAttachmentType | null {
  const b = bytes;
  if (b.byteLength < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x89 &&
    ascii(b, 1, 3) === "PNG" &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  const gif = ascii(b, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  const iso = sniffIsoBmff(b);
  if (iso) return iso;
  const window = ascii(b, 0, Math.min(b.byteLength, PDF_HEADER_WINDOW));
  if (window.includes("%PDF-")) return "application/pdf";
  return null;
}
