// Shared EXIF JPEG fixture builder (moved from photo-exif.test.ts for OPE-1341).
/**
 * Builds a real EXIF JPEG byte-for-byte, so the parser is exercised against
 * actual structure (marker chain → TIFF header → IFD0 → sub-IFDs) rather than
 * a mock. Little-endian ("II"), which is what iPhones and most cameras emit.
 */
export function buildJpegWithExif(opts: {
  gps?: {
    latDms: [number, number, number];
    latRef: string;
    lonDms: [number, number, number];
    lonRef: string;
  };
  dateTimeOriginal?: string;
  bigEndian?: boolean;
  /** Emit the GPS/Exif IFDs but with a bogus pointer, to test robustness. */
  corruptPointer?: boolean;
}): Uint8Array {
  const little = !opts.bigEndian;
  const chunks: number[] = [];
  const tiff: number[] = [];

  const u16 = (arr: number[], v: number) => {
    if (little) arr.push(v & 0xff, (v >> 8) & 0xff);
    else arr.push((v >> 8) & 0xff, v & 0xff);
  };
  const u32 = (arr: number[], v: number) => {
    if (little) arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    else arr.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  };

  // TIFF header
  if (little) tiff.push(0x49, 0x49);
  else tiff.push(0x4d, 0x4d);
  u16(tiff, 0x002a);
  u32(tiff, 8); // IFD0 at offset 8

  const heap: number[] = [];
  const ifd0Count = (opts.gps ? 1 : 0) + (opts.dateTimeOriginal ? 1 : 0);
  // IFD0 starts at 8: 2 (count) + 12*n + 4 (next) → heap begins after.
  const ifd0Size = 2 + 12 * ifd0Count + 4;
  let heapBase = 8 + ifd0Size;

  // --- GPS IFD ---
  let gpsIfdOffset = 0;
  if (opts.gps) {
    const gpsEntryCount = 4;
    const gpsIfdSize = 2 + 12 * gpsEntryCount + 4;
    gpsIfdOffset = heapBase;
    const gpsHeapBase = gpsIfdOffset + gpsIfdSize;
    const gpsIfd: number[] = [];
    const gpsHeap: number[] = [];
    u16(gpsIfd, gpsEntryCount);

    // 0x0001 GPSLatitudeRef (ASCII, 2) — inline
    u16(gpsIfd, 0x0001);
    u16(gpsIfd, 2);
    u32(gpsIfd, 2);
    gpsIfd.push(opts.gps.latRef.charCodeAt(0), 0, 0, 0);
    // 0x0002 GPSLatitude (RATIONAL x3, 24 bytes) — heap
    u16(gpsIfd, 0x0002);
    u16(gpsIfd, 5);
    u32(gpsIfd, 3);
    u32(gpsIfd, gpsHeapBase + gpsHeap.length);
    for (const v of opts.gps.latDms) {
      u32(gpsHeap, Math.round(v * 10000));
      u32(gpsHeap, 10000);
    }
    // 0x0003 GPSLongitudeRef
    u16(gpsIfd, 0x0003);
    u16(gpsIfd, 2);
    u32(gpsIfd, 2);
    gpsIfd.push(opts.gps.lonRef.charCodeAt(0), 0, 0, 0);
    // 0x0004 GPSLongitude
    u16(gpsIfd, 0x0004);
    u16(gpsIfd, 5);
    u32(gpsIfd, 3);
    u32(gpsIfd, gpsHeapBase + gpsHeap.length);
    for (const v of opts.gps.lonDms) {
      u32(gpsHeap, Math.round(v * 10000));
      u32(gpsHeap, 10000);
    }

    u32(gpsIfd, 0); // next IFD
    heap.push(...gpsIfd, ...gpsHeap);
    heapBase = gpsHeapBase + gpsHeap.length;
  }

  // --- Exif IFD ---
  let exifIfdOffset = 0;
  if (opts.dateTimeOriginal) {
    const exifIfdSize = 2 + 12 * 1 + 4;
    exifIfdOffset = heapBase;
    const exifHeapBase = exifIfdOffset + exifIfdSize;
    const exifIfd: number[] = [];
    const exifHeap: number[] = [];
    u16(exifIfd, 1);
    const s = opts.dateTimeOriginal + "\0";
    u16(exifIfd, 0x9003);
    u16(exifIfd, 2);
    u32(exifIfd, s.length);
    u32(exifIfd, exifHeapBase);
    for (const ch of s) exifHeap.push(ch.charCodeAt(0));
    u32(exifIfd, 0);
    heap.push(...exifIfd, ...exifHeap);
    heapBase = exifHeapBase + exifHeap.length;
  }

  // IFD0
  const ifd0: number[] = [];
  u16(ifd0, ifd0Count);
  if (opts.dateTimeOriginal) {
    u16(ifd0, 0x8769);
    u16(ifd0, 4);
    u32(ifd0, 1);
    u32(ifd0, opts.corruptPointer ? 0x7fffffff : exifIfdOffset);
  }
  if (opts.gps) {
    u16(ifd0, 0x8825);
    u16(ifd0, 4);
    u32(ifd0, 1);
    u32(ifd0, opts.corruptPointer ? 0x7fffffff : gpsIfdOffset);
  }
  u32(ifd0, 0);

  tiff.push(...ifd0, ...heap);

  // JPEG wrapper: SOI + APP1("Exif\0\0" + tiff) + SOS
  chunks.push(0xff, 0xd8);
  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const segLen = app1Payload.length + 2;
  chunks.push(0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...app1Payload);
  chunks.push(0xff, 0xda, 0x00, 0x02); // SOS
  return new Uint8Array(chunks);
}
