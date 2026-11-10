/**
 * OPE-1618 — season spreadsheet import: parsing (CSV + a real XLSX built here),
 * row validation, preview/commit against the MCP suite's full schema (with the
 * real 0406 + 0410 DDL), idempotency, the D1 bound-parameter cap, and the
 * route's owner-only gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({
    ok: true,
    userId: "u-joyce",
    email: "joyce@example.org",
  })),
}));

import { parseCsv, parseXlsx, readSpreadsheet, sha256Hex } from "../spreadsheet";
import { TEMPLATE_COLUMNS, parseDateCell, parseHoursCell, parseRows, templateCsv } from "../rows";
import { COMMIT_PAGE, PREVIEW_PAGE, commitRows, previewRows } from "../run";
import { POST as importPost } from "@/app/api/promoter/events/import/route";
import { GET as templateGet } from "@/app/api/promoter/events/import/template/route";

// ------------------------------------------------------------------ XLSX builder

const enc = new TextEncoder();
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const out = await new Response(
    new Response(new Uint8Array(data)).body!.pipeThrough(new CompressionStream("deflate-raw"))
  ).arrayBuffer();
  return new Uint8Array(out);
}
/** A minimal ZIP writer (no CRC check on read, so CRC is left 0). */
async function zip(files: Record<string, string>, compress: boolean): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const plain = enc.encode(text);
    const data = compress ? await deflateRaw(plain) : plain;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, compress ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, plain.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, compress ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, plain.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const buf = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    buf.set(p, o);
    o += p.length;
  }
  return buf;
}
const xlsxFiles = {
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Season" sheetId="1" r:id="rId7"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/season.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Event name *</t></si><si><t>Start date *</t></si><si><t>City *</t></si><si><t>State *</t></si><si><r><t>Fall </t></r><r><t>Craft &amp; Gift Fair</t></r></si><si><t>Concord</t></si></sst>`,
  // B2 is an Excel date serial (46662 = 2027-10-02); D2 is an inline string; C1..D1 headers.
  "xl/worksheets/season.xml": `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
    <row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>46662</v></c><c r="C2" t="s"><v>5</v></c><c r="D2" t="inlineStr"><is><t>NH</t></is></c></row>
  </sheetData></worksheet>`,
};

// ------------------------------------------------------------------ parsing

describe("spreadsheet reading", () => {
  it("reads CSV with quotes, embedded commas/newlines and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n,\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  for (const compress of [false, true]) {
    it(`reads an XLSX (${compress ? "deflated" : "stored"}): shared + rich + inline strings, the sheet the workbook names`, async () => {
      const bytes = await zip(xlsxFiles, compress);
      const rows = await parseXlsx(bytes);
      expect(rows).toEqual([
        ["Event name *", "Start date *", "City *", "State *"],
        ["Fall Craft & Gift Fair", "46662", "Concord", "NH"],
      ]);
      const sheet = await readSpreadsheet(bytes);
      expect(sheet.kind).toBe("xlsx");
      const parsed = parseRows(sheet.rows);
      expect(parsed.rows[0].value).toMatchObject({
        name: "Fall Craft & Gift Fair",
        startDate: "2027-10-02",
        city: "Concord",
        state: "NH",
      });
    });
  }

  it("refuses a file that only looks like a ZIP", async () => {
    await expect(parseXlsx(new Uint8Array([0x50, 0x4b, 1, 2, 3]))).rejects.toThrow(/not a ZIP/);
  });
});

describe("template and row validation", () => {
  it("the template's own example row parses clean, required columns are marked", () => {
    const csv = templateCsv();
    expect(csv.split("\r\n")[0]).toContain("Event name *");
    expect(TEMPLATE_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual([
      "name",
      "start_date",
      "city",
      "state",
    ]);
    const { rows, headerErrors } = parseRows(parseCsv(csv));
    expect(headerErrors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].warnings).toEqual([]);
    expect(rows[0].value).toMatchObject({
      hours: { open: "09:00", close: "16:00" },
      ticketPriceMin: 0,
      vendorFeeMin: 75,
      vendorFeeMax: 125,
      categories: ["Craft Fair", "Holiday Market"],
    });
  });

  it("reads the date and hour forms promoters write, and refuses guesses", () => {
    expect(
      ["2027-10-02", "10/2/2027", "10/2/27", "October 2, 2027", "Sat, Oct 2nd 2027", "46662"].map(
        parseDateCell
      )
    ).toEqual(Array(6).fill("2027-10-02"));
    expect(parseDateCell("2/30/2027")).toBeNull();
    expect(parseHoursCell("9am-4pm")).toEqual({ open: "09:00", close: "16:00" });
    expect(parseHoursCell("9:30 AM – 4:30 PM")).toEqual({ open: "09:30", close: "16:30" });
    expect(parseHoursCell("10-4")).toEqual({ open: "10:00", close: "16:00" });
    expect(parseHoursCell("1-4pm")).toEqual({ open: "13:00", close: "16:00" });
    expect(parseHoursCell("09:00-17:00")).toEqual({ open: "09:00", close: "17:00" });
    expect(parseHoursCell("4pm-9am")).toBeNull();
    expect(parseHoursCell("all day")).toBeNull();
  });

  it("keeps only allow-listed categories, matched case-insensitively, and says what it left off", () => {
    const { rows } = parseRows([
      ["Event name", "Start date", "City", "State", "Categories"],
      ["A", "2027-06-01", "X", "NH", "craft fair; Basket Weaving Bee | AGRICULTURAL FAIR"],
    ]);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].value!.categories).toEqual(["Craft Fair", "Agricultural Fair"]);
    expect(rows[0].warnings).toEqual([
      "Category not used on our site, left off: Basket Weaving Bee.",
    ]);
  });

  it("names a missing required column, and each bad cell by column", () => {
    expect(parseRows([["Event name", "Start date"]]).headerErrors[0]).toMatch(
      /Missing required columns: City, State/
    );
    const { rows } = parseRows([
      ["Name", "Start", "End", "Town", "State", "Booth fee min", "Event URL"],
      ["A", "13/45/2027", "", "X", "NY", "lots", "example.org"],
      ["B", "2027-06-02", "2027-06-01", "X", "NH", "", ""],
    ]);
    expect(rows[0].errors.join(" ")).toMatch(/Start date "13\/45\/2027"/);
    expect(rows[0].errors.join(" ")).toMatch(/State "NY"/);
    expect(rows[0].errors.join(" ")).toMatch(/Booth fee min "lots"/);
    expect(rows[0].errors.join(" ")).toMatch(/Event URL must start with https/);
    expect(rows[1].errors).toEqual(["End date is before the start date."]);
  });
});

// ------------------------------------------------------------------ preview / commit

const sec = (ymd: string) =>
  Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), 12) / 1000);
const HEADER = [
  "Event name",
  "Start date",
  "End date",
  "Daily hours",
  "Venue name",
  "City",
  "State",
  "Booth fee min",
  "Event URL",
];

/** Joyce-shaped: 10 new shows, 3 of her existing ones (one with a changed fee), 2 broken rows. */
function seasonCsv(): string {
  const lines = [HEADER.join(",")];
  for (let i = 1; i <= 10; i++)
    lines.push(
      `New Show ${i},2027-0${(i % 9) + 1}-1${i % 10},,9am-4pm,Grange Hall ${i},Town${i},NH,60,`
    );
  lines.push(
    "Hopkinton Holiday Fair,2027-11-20,,,Hopkinton Fairgrounds,Contoocook,NH,95,https://joyce.example/hopkinton"
  );
  lines.push("Concord Spring Show,2027-04-10,,,,Concord,NH,,https://joyce.example/concord");
  lines.push("Keene Fall Show,2027-09-25,,,,Keene,NH,,https://joyce.example/keene");
  lines.push("Broken Date Show,2027-13-40,,,,Nashua,NH,,");
  lines.push("No State Show,2027-05-05,,,,Nashua,,,");
  return lines.join("\n");
}

const ctx = (over: Partial<Parameters<typeof commitRows>[1]> = {}) => ({
  promoterId: "p-joyce",
  fileHash: "h1",
  fileName: "season.csv",
  uploadedBy: "u-joyce",
  channel: "portal" as const,
  now: new Date("2026-11-10T22:00:00Z"),
  ...over,
});
const n = (sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...p) as { n: number }).n;

beforeEach(() => {
  ({ raw, db } = createTestDb());
  // Prod's event_days key (drizzle/0299) — the shared upsert targets it; the harness omits it.
  raw.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_days_event_date_vendor ON event_days(event_id, date, vendor_only)"
  );
  raw
    .prepare(
      "INSERT INTO users (id, email, role) VALUES ('u-joyce','joyce@example.org','PROMOTER'), ('u-other','o@example.org','PROMOTER')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, user_id, claimed) VALUES ('p-joyce','Joyce''s Craft Shows','joyce','u-joyce',1), ('p-other','Other Org','other','u-other',1)"
    )
    .run();
  const ev = raw.prepare(
    "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url, vendor_fee_min_cents) VALUES (?,?,?,?,?,?, 'APPROVED', ?, ?)"
  );
  ev.run(
    "e-hop",
    "Hopkinton Holiday Fair",
    "hopkinton-holiday-fair",
    "p-joyce",
    sec("2027-11-20"),
    sec("2027-11-20"),
    "https://joyce.example/hopkinton",
    8500
  );
  ev.run(
    "e-con",
    "Concord Spring Show",
    "concord-spring-show",
    "p-joyce",
    sec("2027-04-10"),
    sec("2027-04-10"),
    "https://joyce.example/concord",
    null
  );
  ev.run(
    "e-kee",
    "Keene Fall Show",
    "keene-fall-show",
    "p-joyce",
    sec("2027-09-25"),
    sec("2027-09-25"),
    "https://joyce.example/keene",
    null
  );
  ev.run(
    "e-theirs",
    "Laconia Antiques Show",
    "laconia",
    "p-other",
    sec("2027-07-04"),
    sec("2027-07-04"),
    "https://other.example/laconia",
    null
  );
});
afterEach(() => raw.close());

describe("preview and commit", () => {
  it("acceptance: 15 rows → 10 new, 3 matches, 2 errors; only the ticked rows commit", async () => {
    const { rows } = parseRows(parseCsv(seasonCsv()));
    expect(rows).toHaveLength(15);
    const preview = await previewRows(db as never, { promoterId: "p-joyce", fileHash: "h1", rows });
    const by = (s: string) => preview.filter((p) => p.status === s);
    expect([
      by("new").length,
      by("match").length,
      by("error").length,
      by("already_imported").length,
    ]).toEqual([10, 3, 2, 0]);
    expect(
      by("match")
        .map((p) => p.event!.id)
        .sort()
    ).toEqual(["e-con", "e-hop", "e-kee"]);
    expect(by("match").find((p) => p.event!.id === "e-hop")!.changes).toEqual({
      booth_fee_min: { current: "85.00", proposed: "95.00" },
    });
    expect(n("SELECT count(*) n FROM events")).toBe(4); // preview wrote nothing

    // Tick 8 of the new rows and 2 of the matches (and one error row, which must be refused).
    const ticked = new Set([
      ...by("new")
        .slice(0, 8)
        .map((p) => p.row),
      by("match")[0].row,
      by("match")[1].row,
      by("error")[0].row,
    ]);
    const results = await commitRows(db as never, ctx(), rows, ticked);
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(8);
    expect(results.filter((r) => r.outcome === "update_staged")).toHaveLength(2);
    expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(1);
    expect(n("SELECT count(*) n FROM events")).toBe(12);
    expect(
      n("SELECT count(*) n FROM events WHERE status='PENDING' AND promoter_id='p-joyce'")
    ).toBe(8);
    // The matched event is NOT changed; the change is staged + flagged.
    expect(
      (
        raw.prepare("SELECT vendor_fee_min_cents v FROM events WHERE id='e-hop'").get() as {
          v: number;
        }
      ).v
    ).toBe(8500);
    const staged = raw
      .prepare("SELECT proposed_changes FROM promoter_import_rows WHERE event_id='e-hop'")
      .get() as { proposed_changes: string };
    expect(JSON.parse(staged.proposed_changes)).toEqual({
      booth_fee_min: { current: "85.00", proposed: "95.00" },
    });
    expect(
      n(
        "SELECT count(*) n FROM event_review_flags WHERE event_id='e-hop' AND reason='promoter_import_update'"
      )
    ).toBe(1);
    // A match with no differences stages a row but raises no flag.
    expect(
      n("SELECT count(*) n FROM event_review_flags WHERE reason='promoter_import_update'")
    ).toBe(1);
  });

  it("cites every value to the upload, provenance promoter_portal", async () => {
    const { rows } = parseRows(parseCsv(seasonCsv()));
    const [created] = await commitRows(db as never, ctx(), rows, new Set([2]));
    expect(created.outcome).toBe("created");
    const cites = raw
      .prepare(
        "SELECT field_name, value, source_url, provenance_kind, notes FROM event_data_citations WHERE event_id=? ORDER BY field_name"
      )
      .all(created.event_id) as Array<{
      field_name: string;
      value: string;
      source_url: string;
      provenance_kind: string;
      notes: string;
    }>;
    expect(cites.map((c) => c.field_name)).toEqual([
      "end_date",
      "hours",
      "name",
      "start_date",
      "vendor_fee_max_cents",
      "vendor_fee_min_cents",
      "venue",
    ]);
    expect(new Set(cites.map((c) => c.provenance_kind))).toEqual(new Set(["promoter_portal"]));
    expect(cites[0].source_url).toBe("promoter-upload:sha256:h1#row=2");
    expect(JSON.parse(cites[0].notes)).toMatchObject({
      file_hash: "h1",
      row: 2,
      uploaded_by: "u-joyce",
      channel: "portal",
    });
    expect(n("SELECT count(*) n FROM event_days WHERE event_id=?", created.event_id)).toBe(1);
  });

  it("re-uploading the same file creates nothing new", async () => {
    const { rows } = parseRows(parseCsv(seasonCsv()));
    const all = new Set(rows.filter((r) => r.value).map((r) => r.rowNumber));
    const first: Awaited<ReturnType<typeof commitRows>> = [];
    for (const page of [...all].reduce<number[][]>(
      (a, r, i) => (i % COMMIT_PAGE ? a[a.length - 1].push(r) : a.push([r]), a),
      []
    ))
      first.push(...(await commitRows(db as never, ctx(), rows, new Set(page))));
    const events1 = n("SELECT count(*) n FROM events");
    const ledger1 = n("SELECT count(*) n FROM promoter_import_rows");
    expect(ledger1).toBe(13);
    const again = await previewRows(db as never, {
      promoterId: "p-joyce",
      fileHash: "h1",
      rows: rows.slice(0, PREVIEW_PAGE),
    });
    expect(again.filter((p) => p.status === "already_imported")).toHaveLength(13);
    const second = await commitRows(
      db as never,
      ctx(),
      rows,
      new Set([...all].slice(0, COMMIT_PAGE))
    );
    expect(second.every((r) => r.outcome === "skipped")).toBe(true);
    expect(n("SELECT count(*) n FROM events")).toBe(events1);
    expect(n("SELECT count(*) n FROM promoter_import_rows")).toBe(ledger1);
    // A re-saved copy (different hash) dedups against the events the first upload created.
    const copy = await previewRows(db as never, {
      promoterId: "p-joyce",
      fileHash: "h2",
      rows: rows.slice(0, 10),
    });
    expect(copy.filter((p) => p.status === "new")).toHaveLength(0);
  });

  it("a row matching ANOTHER organizer's event is an error, not an update", async () => {
    const { rows } = parseRows([
      HEADER,
      [
        "Laconia Antiques Show",
        "2027-07-04",
        "",
        "",
        "",
        "Laconia",
        "NH",
        "",
        "https://other.example/laconia",
      ],
    ]);
    const [p] = await previewRows(db as never, { promoterId: "p-joyce", fileHash: "h3", rows });
    expect(p.status).toBe("error");
    expect(p.errors[0]).toMatch(/another organizer lists/);
    const [c] = await commitRows(db as never, ctx({ fileHash: "h3" }), rows, new Set([2]));
    expect(c.outcome).toBe("skipped");
    expect(n("SELECT count(*) n FROM promoter_import_rows")).toBe(0);
  });

  it("a 200-row file commits in pages without any statement over D1's 100 bound parameters", async () => {
    const lines = [HEADER.join(",")];
    for (let i = 0; i < 200; i++) {
      // 8 days apart: "Bulk Show 10" / "Bulk Show 11" on adjacent days would be (rightly) near-duplicates.
      const d = new Date(Date.UTC(2027, 0, 1) + i * 8 * 86_400_000).toISOString().slice(0, 10);
      lines.push(
        `Bulk Show ${i},${d},,9am-4pm,Hall ${i},Town${i},NH,50,https://joyce.example/bulk-${i}`
      );
    }
    const { rows } = parseRows(parseCsv(lines.join("\n")));
    expect(rows).toHaveLength(200);
    let maxParams = 0;
    let statements = 0;
    const orig = raw.prepare.bind(raw);
    raw.prepare = ((sql: string) => {
      statements++;
      maxParams = Math.max(maxParams, (sql.match(/\?/g) ?? []).length);
      return orig(sql);
    }) as typeof raw.prepare;
    for (let i = 0; i < rows.length; i += COMMIT_PAGE) {
      const page = new Set(rows.slice(i, i + COMMIT_PAGE).map((r) => r.rowNumber));
      await commitRows(db as never, ctx({ fileHash: "h200" }), rows, page);
    }
    // positive landmark: the writes really went through the instrumented prepare
    expect(statements).toBeGreaterThan(1000);
    expect(n("SELECT count(*) n FROM events WHERE name LIKE 'Bulk Show %'")).toBe(200);
    // 8 cited values per row: name, start, end, venue, hours, fee min, fee max, event URL
    expect(n("SELECT count(*) n FROM event_data_citations")).toBe(1600);
    expect(maxParams).toBeLessThanOrEqual(100);
  });

  it("refuses pages larger than the query budget allows", async () => {
    const { rows } = parseRows(parseCsv(seasonCsv()));
    const many = Array.from({ length: 26 }, (_, i) => ({ ...rows[0], rowNumber: 100 + i }));
    await expect(
      commitRows(db as never, ctx(), many, new Set(many.map((r) => r.rowNumber)))
    ).rejects.toThrow(/at most 25/);
  });
});

// ------------------------------------------------------------------ routes

const upload = (csv: string, fields: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("file", new File([csv], "season.csv", { type: "text/csv" }));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return importPost(
    new Request("https://meetmeatthefair.com/api/promoter/events/import", {
      method: "POST",
      body: fd,
    }) as never
  );
};

describe("routes", () => {
  it("serves the template as a CSV download", async () => {
    const res = templateGet();
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=/);
    expect(await res.text()).toBe(templateCsv());
  });

  it("previews and commits for the session's own claimed promoter", async () => {
    const res = await upload(seasonCsv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      file_hash: string;
      rows: Array<{ status: string; row: number }>;
    };
    expect(body).toMatchObject({ total_rows: 15, next_offset: null, kind: "csv" });
    expect(body.file_hash).toBe(await sha256Hex(new TextEncoder().encode(seasonCsv())));
    const newRow = body.rows.find((r) => r.status === "new")!.row;
    const commit = await upload(seasonCsv(), { action: "commit", rows: JSON.stringify([newRow]) });
    expect(((await commit.json()) as { results: unknown[] }).results[0]).toMatchObject({
      outcome: "created",
    });
    expect(
      n(
        "SELECT count(*) n FROM promoter_import_rows WHERE promoter_id='p-joyce' AND channel='portal'"
      )
    ).toBe(1);
  });

  it("refuses an unclaimed promoter", async () => {
    raw.prepare("UPDATE promoters SET claimed=0 WHERE id='p-joyce'").run();
    const res = await upload(seasonCsv());
    expect(res.status).toBe(403);
    expect(n("SELECT count(*) n FROM promoter_import_rows")).toBe(0);
  });

  it("reports a broken header as 422 with the reason", async () => {
    const res = await upload("Name,When\nA,2027-01-01");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { header_errors: string[] }).header_errors[0]).toMatch(
      /Missing required columns/
    );
  });
});
