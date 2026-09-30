/**
 * OPE-584 — every MCP tool that mints a slug decodes the name first.
 *
 * `createSlug` was never the bug: it maps a literal `&` to "and". The damage
 * came from a CALLER feeding it an undecoded name — `Kevin Niles &amp; Company`
 * slugs to `kevin-niles-andamp-company`. admin-performers.ts was the one tool
 * that skipped the decode; 13 live performer URLs were minted wrong before
 * #1049 fixed it (backfilled 2026-09-30).
 *
 * performer-name-decode-ope584.test.ts guards admin-performers.ts alone. This
 * extends the same rule to every tool file that calls `createSlug`, so a new
 * entity path cannot regress while the others pass — the ticket's "covers
 * performers, vendors, venues, events, promoters" acceptance.
 *
 * Keyed on the ACT, not on one spelling of the fix: a field is decoded when it
 * reaches `.transform(decodeHtmlEntities)` OR `.transform(sanitizeProse)`
 * (which is `stripToolCallMarkup(decodeHtmlEntities(x))`). A grep for the
 * literal `decodeHtmlEntities` would false-flag vendor.ts, which decodes
 * through sanitizeProse.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createSlug, decodeHtmlEntities } from "@takemetothefair/utils";

/** The zod fields whose values reach `createSlug` in the tool files. */
const SLUGGED_FIELDS = new Set(["name", "venue_name", "business_name", "company_name"]);
const DECODES = /\.transform\((decodeHtmlEntities|sanitizeProse)\)/;

const toolsDir = resolve(__dirname, "../src/tools");
const slugMinters = readdirSync(toolsDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, src: readFileSync(resolve(toolsDir, f), "utf8") }))
  .filter(({ src }) => src.includes("createSlug("));

/**
 * Each `<field>: z…` declaration: its own line plus the `.method()` lines that
 * continue the chain. Stops at the first line that is not a continuation, so a
 * field can never borrow the NEXT field's transform — the first version of this
 * cut at "`),` + newline" and went green on a mutant whose line carried a
 * trailing comment, because the body ran on into `venue_name`'s sanitizeProse.
 */
function declarations(src: string): Array<{ field: string; body: string }> {
  const out: Array<{ field: string; body: string }> = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s+(\w+): z\b/.exec(line);
    if (!m || !SLUGGED_FIELDS.has(m[1])) return;
    const body = [line];
    for (let j = i + 1; j < lines.length && /^\s*\./.test(lines[j]); j++) body.push(lines[j]);
    out.push({ field: m[1], body: body.join("\n") });
  });
  return out;
}

describe("createSlug — the shared generator every entity uses", () => {
  it("maps a literal & to 'and'", () => {
    expect(createSlug("A & B")).toBe("a-and-b");
    expect(createSlug("Test & Co")).toBe("test-and-co");
  });

  it("decode-then-slug gives the same URL for an entity-encoded name", () => {
    expect(createSlug(decodeHtmlEntities("Test &amp; Co"))).toBe("test-and-co");
    // …and without the decode, the exact defect this guards against:
    expect(createSlug("Test &amp; Co")).toBe("test-andamp-co");
  });
});

describe("every slug-minting MCP tool decodes the name it slugs", () => {
  const all = slugMinters.flatMap(({ file, src }) =>
    declarations(src).map((d) => ({ file, ...d }))
  );

  it("finds the slug-minting tools and their name fields (positive landmark)", () => {
    // If the scan silently stops matching, the assertion below goes vacuously
    // green. Measured 2026-09-30: 3 files, 13 name-type declarations.
    expect(slugMinters.map((m) => m.file).sort()).toEqual(
      expect.arrayContaining(["admin-performers.ts", "admin.ts", "vendor.ts"])
    );
    expect(all.length).toBeGreaterThanOrEqual(13);
  });

  it("each name-type field passes through a decoding transform", () => {
    const missing = all.filter((d) => !DECODES.test(d.body));
    expect(missing.map((d) => `${d.file} ${d.field}: ${d.body.split("\n")[0].trim()}`)).toEqual([]);
  });
});
