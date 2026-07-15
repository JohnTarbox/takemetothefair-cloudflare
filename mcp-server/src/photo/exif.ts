/**
 * OPE-203 — minimal, dependency-free EXIF reader for the `photos@` lane.
 *
 * Extracts ONLY the two tags that identify which fair a photo came from:
 *   - GPS latitude/longitude  → which venue
 *   - DateTimeOriginal        → which occurrence at that venue
 * A fair is a venue × date, and a phone photo carries both.
 *
 * WHY HAND-ROLLED: this runs in the MCP Worker. `sharp` is native (no Workers
 * build) and no EXIF dependency exists in either package. The format subset we
 * need is small and stable, so we walk it directly rather than pull a parser
 * that drags in Buffer/fs polyfills.
 *
 * PRIVACY: this READS GPS from the bytes captured in R2
 * (`inbound-attachments/...`, which are stored unstripped). It never writes
 * them anywhere public. `src/lib/image-optim.ts:stripExifFromJpeg` remains the
 * gate for anything promoted to the CDN — do not regress that: GPS must never
 * reach a public image. Reading here is in-memory and transient.
 *
 * SCOPE: JPEG only (JFIF/EXIF APP1). HEIC/PNG/WebP return an empty result, so
 * the caller holds rather than guesses — an iPhone set to "High Efficiency"
 * sends HEIC, which is a real and expected miss, not a bug.
 *
 * Deliberately total: every malformed/truncated input returns an empty result
 * instead of throwing. A corrupt photo must degrade to "hold and ask", never
 * fail the inbound workflow.
 */

/** JPEG markers. */
const SOI = 0xd8;
const APP1 = 0xe1;
const SOS = 0xda;

/** TIFF tag ids we care about. */
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
/** Fallback when DateTimeOriginal is absent (some editors drop it). */
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

/** TIFF field types (only the ones the above tags use). */
const TYPE_ASCII = 2;
const TYPE_RATIONAL = 5;

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

export interface ExifGps {
  /** Signed decimal degrees (S/W negative). */
  latitude: number;
  longitude: number;
}

export interface ExifData {
  gps?: ExifGps;
  /**
   * The photo's LOCAL wall-clock capture date, as "YYYY-MM-DD".
   *
   * Deliberately a local date STRING, not a Date/epoch. EXIF DateTimeOriginal
   * carries no timezone — it's wall-clock at the shutter — and `event_days.date`
   * is likewise a local "YYYY-MM-DD" at the venue. Since the photographer is
   * physically standing at the fair, those two are the same clock, and comparing
   * them as strings is exact. Converting through UTC would introduce the classic
   * off-by-one (an 8pm photo at a fair becomes "tomorrow" in UTC) and silently
   * mis-attribute evening shots to the next day's occurrence.
   */
  takenOnLocalDate?: string;
  /** Local wall-clock time "HH:MM:SS", when present. Informational only. */
  takenAtLocalTime?: string;
}

/** Bounds-checked little/big-endian readers over a DataView. */
function readU16(view: DataView, offset: number, little: boolean): number | null {
  if (offset < 0 || offset + 2 > view.byteLength) return null;
  return view.getUint16(offset, little);
}

function readU32(view: DataView, offset: number, little: boolean): number | null {
  if (offset < 0 || offset + 4 > view.byteLength) return null;
  return view.getUint32(offset, little);
}

/**
 * Locate the EXIF TIFF block inside a JPEG.
 *
 * Walks the marker segments rather than scanning for the "Exif" magic, so a
 * JPEG whose *pixel data* happens to contain those bytes can't fool us.
 * Returns the offset of the TIFF header (byte-order mark) or null.
 */
function findTiffOffset(bytes: Uint8Array): number | null {
  // SOI
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;

  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null; // desynced — not a valid segment chain
    const marker = bytes[pos + 1];
    // Standalone markers (fill bytes / RSTn) carry no length.
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    // Once we hit the scan, no more metadata segments follow.
    if (marker === SOS) return null;

    const size = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (size < 2) return null;
    const segStart = pos + 4;
    const segEnd = pos + 2 + size;
    if (segEnd > bytes.length) return null;

    if (marker === APP1) {
      // "Exif\0\0" then the TIFF header. XMP also uses APP1 (an http:// ns
      // string), so check the magic and keep walking if it isn't EXIF.
      if (
        segEnd - segStart >= 6 &&
        bytes[segStart] === 0x45 && // E
        bytes[segStart + 1] === 0x78 && // x
        bytes[segStart + 2] === 0x69 && // i
        bytes[segStart + 3] === 0x66 && // f
        bytes[segStart + 4] === 0x00
      ) {
        return segStart + 6;
      }
    }
    pos = segEnd;
  }
  return null;
}

interface IfdEntry {
  type: number;
  count: number;
  /** Absolute offset of the value (inline 4-byte values are copied out). */
  valueOffset: number;
}

/** Read one IFD into a tag→entry map. `tiff` is the TIFF-header offset. */
function readIfd(
  view: DataView,
  tiff: number,
  ifdOffset: number,
  little: boolean
): Map<number, IfdEntry> {
  const out = new Map<number, IfdEntry>();
  const count = readU16(view, ifdOffset, little);
  if (count === null || count > 512) return out; // sanity cap on absurd counts

  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = readU16(view, entry, little);
    const type = readU16(view, entry + 2, little);
    const n = readU32(view, entry + 4, little);
    if (tag === null || type === null || n === null) break;

    const size = TYPE_SIZES[type];
    if (!size) continue; // unknown type — skip, don't guess at its width
    const bytesNeeded = size * n;
    // Values ≤4 bytes live inline in the entry; larger ones are referenced by
    // an offset relative to the TIFF header.
    let valueOffset: number;
    if (bytesNeeded <= 4) {
      valueOffset = entry + 8;
    } else {
      const rel = readU32(view, entry + 8, little);
      if (rel === null) continue;
      valueOffset = tiff + rel;
    }
    if (valueOffset < 0 || valueOffset + bytesNeeded > view.byteLength) continue;
    out.set(tag, { type, count: n, valueOffset });
  }
  return out;
}

function readAscii(view: DataView, entry: IfdEntry): string | null {
  if (entry.type !== TYPE_ASCII) return null;
  let s = "";
  for (let i = 0; i < entry.count; i++) {
    const c = view.getUint8(entry.valueOffset + i);
    if (c === 0) break; // NUL-terminated
    s += String.fromCharCode(c);
  }
  return s;
}

/** Read a RATIONAL triple (degrees, minutes, seconds) → decimal degrees. */
function readDms(view: DataView, entry: IfdEntry, little: boolean): number | null {
  if (entry.type !== TYPE_RATIONAL || entry.count < 3) return null;
  const parts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const off = entry.valueOffset + i * 8;
    const num = readU32(view, off, little);
    const den = readU32(view, off + 4, little);
    if (num === null || den === null || den === 0) return null;
    parts.push(num / den);
  }
  const [deg, min, sec] = parts;
  const dd = deg + min / 60 + sec / 3600;
  return Number.isFinite(dd) ? dd : null;
}

/**
 * Parse "YYYY:MM:DD HH:MM:SS" (the EXIF format) into local date + time parts.
 * Returns null for the all-zero placeholder some cameras write.
 */
function parseExifDateTime(raw: string): { date: string; time: string } | null {
  const m = raw.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === "0000" || mo === "00" || d === "00") return null;
  // Range-check rather than trust the file.
  const yi = Number(y);
  const moi = Number(mo);
  const di = Number(d);
  if (yi < 1990 || yi > 2100 || moi < 1 || moi > 12 || di < 1 || di > 31) return null;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${s}` };
}

/**
 * Extract GPS + capture date from JPEG bytes.
 *
 * Never throws: any malformed input yields `{}` so the caller holds the photo
 * and asks, rather than failing the workflow or guessing a fair.
 */
export function parseExif(bytes: Uint8Array): ExifData {
  try {
    const tiff = findTiffOffset(bytes);
    if (tiff === null) return {};

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // TIFF header: "II" (0x4949, little) or "MM" (0x4d4d, big), then magic 42.
    const bom = readU16(view, tiff, false);
    if (bom === null) return {};
    let little: boolean;
    if (bom === 0x4949) little = true;
    else if (bom === 0x4d4d) little = false;
    else return {};

    if (readU16(view, tiff + 2, little) !== 0x002a) return {};
    const ifd0Rel = readU32(view, tiff + 4, little);
    if (ifd0Rel === null) return {};

    const ifd0 = readIfd(view, tiff, tiff + ifd0Rel, little);
    const result: ExifData = {};

    // ── Capture time (ExifIFD) ────────────────────────────────────────────
    const exifPtr = ifd0.get(TAG_EXIF_IFD_POINTER);
    if (exifPtr) {
      const rel = readU32(view, exifPtr.valueOffset, little);
      if (rel !== null) {
        const exifIfd = readIfd(view, tiff, tiff + rel, little);
        const dtEntry = exifIfd.get(TAG_DATETIME_ORIGINAL) ?? exifIfd.get(TAG_DATETIME_DIGITIZED);
        if (dtEntry) {
          const raw = readAscii(view, dtEntry);
          const parsed = raw ? parseExifDateTime(raw) : null;
          if (parsed) {
            result.takenOnLocalDate = parsed.date;
            result.takenAtLocalTime = parsed.time;
          }
        }
      }
    }

    // ── GPS (GPSIFD) ──────────────────────────────────────────────────────
    const gpsPtr = ifd0.get(TAG_GPS_IFD_POINTER);
    if (gpsPtr) {
      const rel = readU32(view, gpsPtr.valueOffset, little);
      if (rel !== null) {
        const gpsIfd = readIfd(view, tiff, tiff + rel, little);
        const latEntry = gpsIfd.get(TAG_GPS_LAT);
        const lonEntry = gpsIfd.get(TAG_GPS_LON);
        const latRefEntry = gpsIfd.get(TAG_GPS_LAT_REF);
        const lonRefEntry = gpsIfd.get(TAG_GPS_LON_REF);
        if (latEntry && lonEntry) {
          const lat = readDms(view, latEntry, little);
          const lon = readDms(view, lonEntry, little);
          const latRef = latRefEntry ? readAscii(view, latRefEntry) : null;
          const lonRef = lonRefEntry ? readAscii(view, lonRefEntry) : null;
          if (lat !== null && lon !== null) {
            const latSigned = latRef?.toUpperCase() === "S" ? -lat : lat;
            const lonSigned = lonRef?.toUpperCase() === "W" ? -lon : lon;
            // A (0,0) fix is Null Island — the classic "GPS present but
            // unset" sentinel. Treat as absent rather than resolve to the
            // Gulf of Guinea.
            const isNullIsland = Math.abs(latSigned) < 1e-6 && Math.abs(lonSigned) < 1e-6;
            if (!isNullIsland && Math.abs(latSigned) <= 90 && Math.abs(lonSigned) <= 180) {
              result.gps = { latitude: latSigned, longitude: lonSigned };
            }
          }
        }
      }
    }

    return result;
  } catch {
    // Total by contract — a corrupt photo holds, it never breaks the lane.
    return {};
  }
}
