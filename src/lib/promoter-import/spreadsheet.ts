/**
 * OPE-1618 — read a promoter's season spreadsheet: CSV or XLSX → rows of strings.
 *
 * No third-party parser. The usual XLSX package on npm carries unpatched
 * prototype-pollution / ReDoS advisories, and we need a small, fixed slice of
 * the format: the FIRST worksheet's cell values. An .xlsx file is a ZIP of XML
 * parts; this reads the ZIP central directory, inflates the two parts it needs
 * (`xl/sharedStrings.xml`, the first sheet) with the platform's
 * DecompressionStream (Workers + Node ≥18), and walks the cells. Dates stored
 * as Excel serial numbers come back as their serial; rows.ts converts them.
 */

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF / LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// ------------------------------------------------------------------ ZIP

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipDirectory(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP/XLSX file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt ZIP directory");
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localHeaderOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const MAX_PART_BYTES = 20 * 1024 * 1024;

async function readZipEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const p = e.localHeaderOffset;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error(`corrupt ZIP entry ${e.name}`);
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error(`unsupported ZIP compression ${e.method} in ${e.name}`);
  // Response.body is a byte stream in Workers and Node alike (Blob.stream is not everywhere).
  const stream = new Response(new Uint8Array(data)).body!.pipeThrough(
    new DecompressionStream("deflate-raw")
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PART_BYTES) throw new Error(`${e.name} is larger than ${MAX_PART_BYTES} bytes`);
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
}

// ------------------------------------------------------------------ XLSX

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** Concatenated text of every <t> run inside one <si> / <is>. */
const runText = (xml: string): string =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");

/** "BC" → 54 (0-based column index). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function parseXlsx(bytes: Uint8Array): Promise<string[][]> {
  const entries = readZipDirectory(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  // The first sheet in workbook order: workbook.xml names it, its rels give the path.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = byName.get("xl/workbook.xml");
  const rels = byName.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const wbXml = await readZipEntry(bytes, wb);
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wbXml)?.[1];
    const relXml = await readZipEntry(bytes, rels);
    const target = rid
      ? (new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(relXml)?.[1] ??
        new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(relXml)?.[1])
      : undefined;
    if (target)
      sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = byName.get(sheetPath);
  if (!sheet) throw new Error("the workbook has no readable first sheet");
  const shared: string[] = [];
  const ss = byName.get("xl/sharedStrings.xml");
  if (ss) {
    const xml = await readZipEntry(bytes, ss);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(runText(m[1]));
  }
  const xml = await readZipEntry(bytes, sheet);
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const idx = ref ? columnIndex(ref) : row.length;
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
      else if (type === "inlineStr") value = runText(inner);
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else value = v !== undefined ? decodeXml(v) : "";
      while (row.length < idx) row.push("");
      row[idx] = value;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Either format, decided by the file's own bytes (a ZIP starts "PK"). */
export async function readSpreadsheet(
  bytes: Uint8Array
): Promise<{ kind: "csv" | "xlsx"; rows: string[][] }> {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return { kind: "xlsx", rows: await parseXlsx(bytes) };
  }
  return { kind: "csv", rows: parseCsv(new TextDecoder().decode(bytes)) };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
