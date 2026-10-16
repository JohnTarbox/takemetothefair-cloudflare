/**
 * OPE-1364 — attachment capture now decides by content, so test fixtures need
 * real file signatures. `media(mime, n)` returns `n` bytes (n ≥ header length)
 * that sniff as `mime`; the rest is filler.
 */
const HEADERS: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/jpg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/gif": [...new TextEncoder().encode("GIF89a")],
  "image/webp": [...new TextEncoder().encode("RIFF\0\0\0\0WEBP")],
  // ftyp box: size 24, major "heic", minor 0, compatible mif1 + heic.
  "image/heic": [
    0,
    0,
    0,
    24,
    ...new TextEncoder().encode("ftypheic"),
    0,
    0,
    0,
    0,
    ...new TextEncoder().encode("mif1heic"),
  ],
  "application/pdf": [...new TextEncoder().encode("%PDF-1.7\n")],
};

export function media(mime: string, n: number): Uint8Array {
  const h = HEADERS[mime];
  if (!h) throw new Error(`no magic header for ${mime}`);
  const out = new Uint8Array(Math.max(n, h.length)).fill(65);
  out.set(h, 0);
  return out;
}
