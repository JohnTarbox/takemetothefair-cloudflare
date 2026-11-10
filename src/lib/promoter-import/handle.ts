/**
 * OPE-1618 — the one request handler behind both import routes (the promoter's
 * portal and the operator's admin / MCP path), so the two cannot drift.
 *
 * Stateless: every call carries the file. `preview` returns one page of rows
 * (PREVIEW_PAGE) starting at `offset`; `commit` commits the listed row numbers
 * (at most COMMIT_PAGE). The file hash ties the pages and the ledger together.
 */
import { NextResponse } from "next/server";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { parseRows } from "./rows";
import { readSpreadsheet, sha256Hex } from "./spreadsheet";
import { COMMIT_PAGE, PREVIEW_PAGE, commitRows, previewRows } from "./run";

type Db = ReturnType<typeof getCloudflareDb>;

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ImportRequest {
  bytes: Uint8Array;
  fileName: string | null;
  action: "preview" | "commit";
  offset: number;
  commitRows: number[];
}

export async function handleImport(
  db: Db,
  req: ImportRequest,
  who: { promoterId: string; uploadedBy: string | null; channel: "portal" | "operator" }
): Promise<Response> {
  if (!req.bytes.length) return NextResponse.json({ error: "The file is empty." }, { status: 400 });
  if (req.bytes.length > MAX_FILE_BYTES)
    return NextResponse.json(
      { error: "The file is larger than 2 MB. Split it into smaller files." },
      { status: 413 }
    );
  let sheet;
  try {
    sheet = await readSpreadsheet(req.bytes);
  } catch (e) {
    return NextResponse.json(
      {
        error: `We couldn't read that file (${(e as Error).message}). Save it as CSV or .xlsx and try again.`,
      },
      { status: 400 }
    );
  }
  const fileHash = await sha256Hex(req.bytes);
  const parsed = parseRows(sheet.rows);
  if (parsed.headerErrors.length) {
    return NextResponse.json(
      {
        file_hash: fileHash,
        kind: sheet.kind,
        header_errors: parsed.headerErrors,
        unknown_columns: parsed.unknownColumns,
      },
      { status: 422 }
    );
  }
  if (req.action === "commit") {
    const wanted = new Set(req.commitRows);
    if (wanted.size === 0)
      return NextResponse.json({ error: "No rows selected." }, { status: 400 });
    if (wanted.size > COMMIT_PAGE)
      return NextResponse.json(
        { error: `Commit at most ${COMMIT_PAGE} rows per request.` },
        { status: 400 }
      );
    const results = await commitRows(
      db,
      {
        promoterId: who.promoterId,
        fileHash,
        fileName: req.fileName,
        uploadedBy: who.uploadedBy,
        channel: who.channel,
        now: new Date(),
      },
      parsed.rows,
      wanted
    );
    return NextResponse.json({ file_hash: fileHash, results });
  }
  const offset = Math.max(0, Math.floor(req.offset));
  const page = parsed.rows.slice(offset, offset + PREVIEW_PAGE);
  const rows = await previewRows(db, { promoterId: who.promoterId, fileHash, rows: page });
  const next = offset + PREVIEW_PAGE < parsed.rows.length ? offset + PREVIEW_PAGE : null;
  return NextResponse.json({
    file_hash: fileHash,
    kind: sheet.kind,
    total_rows: parsed.rows.length,
    unknown_columns: parsed.unknownColumns,
    offset,
    next_offset: next,
    commit_page: COMMIT_PAGE,
    rows,
  });
}

/** multipart/form-data: file, action, offset, rows (JSON array of row numbers). */
export async function readMultipart(request: Request): Promise<ImportRequest | { error: string }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { error: "Expected a file upload." };
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return { error: "Expected a file upload." };
  const action = form.get("action") === "commit" ? "commit" : "preview";
  let rows: number[] = [];
  try {
    const raw = form.get("rows");
    rows = raw ? (JSON.parse(String(raw)) as unknown[]).map(Number).filter(Number.isInteger) : [];
  } catch {
    return { error: "rows must be a JSON array of row numbers." };
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name || null,
    action,
    offset: Number(form.get("offset") ?? 0) || 0,
    commitRows: rows,
  };
}
