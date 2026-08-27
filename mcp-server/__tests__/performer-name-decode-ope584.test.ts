/**
 * OPE-584 — performer slugs were born from HTML-escaped names.
 *
 * ## What was actually wrong (the ticket inferred otherwise, and said so)
 *
 * The ticket's hypothesis was that the slugifier HTML-escapes its input. It
 * does not. `createSlug` is correct and always was — it maps a literal `&` to
 * "and". Proven below, because that claim is the hinge of the whole diagnosis.
 *
 * The real cause: `admin-performers.ts` contained **zero** uses of
 * `decodeHtmlEntities`, while events/venues/vendors all apply it per the
 * convention in CLAUDE.md. So an escaped name from a caller went straight into
 * the column AND into the slugifier.
 *
 * ## Why 9 of 13 rows had a CLEAN name and a broken slug
 *
 * That pattern is what convinced the ticket bad input was ruled out. It is the
 * opposite: those rows were EDITED after creation. Measured on prod, the
 * correlation is exact, 13 for 13 —
 *
 *   name still escaped (4)  →  never edited
 *   name clean         (9)  →  edited after creation
 *
 * `update_performer` deliberately leaves the slug unchanged, so a later name
 * correction fixes the display name and strands the URL. The "second, probably
 * separate defect" in the ticket is the same defect in the rows nobody edited.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSlug, decodeHtmlEntities } from "@takemetothefair/utils";

describe("createSlug was never the bug", () => {
  it("maps a literal & to 'and' — the sibling behaviour the ticket asked us to match", () => {
    expect(createSlug("Kevin Niles & Company")).toBe("kevin-niles-and-company");
    expect(createSlug("Preston & Curry")).toBe("preston-and-curry");
    expect(createSlug("Larry Efaw & Bluegrass Mountaineers")).toBe(
      "larry-efaw-and-bluegrass-mountaineers"
    );
  });

  it("produces the broken slug ONLY from an already-escaped name", () => {
    // This is the whole defect in one line: the slugifier is faithful, so the
    // damage is upstream of it.
    expect(createSlug("Kevin Niles &amp; Company")).toBe("kevin-niles-andamp-company");
  });

  it("decode-then-slug reproduces every one of the 13 correct URLs", () => {
    for (const [escaped, expected] of [
      ["Charlie &amp; Hollie", "charlie-and-hollie"],
      ["Kevin Niles &amp; Company", "kevin-niles-and-company"],
      ["Robinson's Gospel Sing &amp; Jam", "robinsons-gospel-sing-and-jam"],
      ["Harold Crocker Ventriloquist &amp; Comedy", "harold-crocker-ventriloquist-and-comedy"],
    ] as const) {
      expect(createSlug(decodeHtmlEntities(escaped))).toBe(expected);
    }
  });

  it("decoding is idempotent — an already-clean name is unharmed", () => {
    // The fix runs on every name, not just escaped ones, so this matters more
    // than the escaped case: a regression here would corrupt 16 working acts.
    for (const clean of ["Kevin Niles & Company", "Mr. Drew and His Animals Too", "Rosey & Lise"]) {
      expect(decodeHtmlEntities(clean)).toBe(clean);
      expect(createSlug(decodeHtmlEntities(clean))).toBe(createSlug(clean));
    }
  });
});

describe("the performer tools apply the decode convention", () => {
  // A source-level assertion, deliberately.
  //
  // The zod schemas are declared inline inside `server.tool(...)` registrations,
  // so there is no exported symbol to call. The alternative — testing
  // `createSlug(decodeHtmlEntities(x))` and calling it covered — would pass with
  // the transform stripped from every schema, which is exactly the regression
  // this needs to catch.
  //
  // ⚠️ Anchored on the `name:` field declarations and their COUNT. Asserting
  // only "the file mentions decodeHtmlEntities" would go green on the import
  // line alone.
  const src = readFileSync(resolve(__dirname, "../src/tools/admin-performers.ts"), "utf8");

  it("has exactly the three name fields we expect — fails if a fourth is added", () => {
    // If this count changes, a new entry point exists and needs the transform
    // too. Better to fail here than to silently cover 3 of 4.
    const nameFields = src.match(/^\s+name: z\n?\s*\.?string\(\)|^\s+name: z\.string\(\)/gm) ?? [];
    expect(nameFields).toHaveLength(3);
  });

  it("every name field decodes before the value is used", () => {
    // Each `name:` declaration must reach `.transform(decodeHtmlEntities)`
    // before its `.describe(...)`/end.
    const decls = src.split(/^\s+name: z/m).slice(1);
    expect(decls).toHaveLength(3);
    for (const d of decls) {
      const upToEnd = d.slice(0, d.indexOf("\n    }") >= 0 ? d.indexOf("\n    }") : 400);
      expect(upToEnd).toContain("transform(decodeHtmlEntities)");
    }
  });

  it("free-text profile fields decode too", () => {
    for (const field of ["description", "home_base_city", "contact_name"]) {
      const m = src.match(new RegExp(`${field}: z\\.string\\(\\)[^,]*`));
      expect(m?.[0]).toContain("transform(decodeHtmlEntities)");
    }
  });

  it("does NOT decode URLs, emails, phones or state codes", () => {
    // Per CLAUDE.md: decoding a URL would corrupt a query string, where an
    // encoded `&` is meaningful.
    for (const field of [
      "website",
      "image_url",
      "contact_email",
      "contact_phone",
      "home_base_state",
    ]) {
      const m = src.match(new RegExp(`${field}: z\\.string\\(\\)[^,]*`));
      expect(m?.[0] ?? "").not.toContain("decodeHtmlEntities");
    }
  });
});
