/**
 * OPE-1324 — the occurrence-path CI guard catches a hand-built copy, including
 * one planted in a file that contains a NUL byte (grep treats such a file as
 * binary and prints nothing; three real files in this repo are like that).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanSource,
  scanRepo,
  OCCURRENCE_PATH_HOME,
} from "../../../scripts/check-occurrence-paths";

const TEMPLATE = "const u = `/events/${series}/${year}`;";

describe("OPE-1324 — check-occurrence-paths", () => {
  it("flags a hand-built /events/${…}/${…} template", () => {
    const o = scanSource("src/lib/x.ts", TEMPLATE);
    expect(o).toHaveLength(1);
    expect(o[0].rule).toBe("template");
  });

  it("flags it inside a file that contains a NUL byte", () => {
    const src = `const SEP = "\u0000";\n${TEMPLATE}\n`;
    expect(src.includes("\u0000")).toBe(true);
    expect(scanSource("src/lib/series/group-events.ts", src).map((o) => o.rule)).toEqual([
      "template",
    ]);
  });

  it("flags getUTCFullYear in a file that handles a series slug, and a /^\\d{4}$/ in an /events/ file", () => {
    const yr = scanSource(
      "src/lib/y.ts",
      "const s = row.canonicalSlug;\nconst y = d.getUTCFullYear();\n"
    );
    expect(yr.map((o) => o.rule)).toEqual(["utc-year"]);
    const re = scanSource("src/lib/z.ts", 'const p = "/events/";\nif (/^\\d{4}$/.test(seg)) {}\n');
    expect(re.map((o) => o.rule)).toEqual(["year-regex"]);
  });

  it("does not flag the home file, the allow-listed facet routes, or an /api/ path", () => {
    expect(scanSource(OCCURRENCE_PATH_HOME, TEMPLATE)).toEqual([]);
    expect(scanSource("src/components/events/facet-nav.tsx", TEMPLATE)).toEqual([]);
    expect(scanSource("src/app/admin/x.tsx", "fetch(`/api/admin/events/${id}/${action}`)")).toEqual(
      []
    );
    expect(scanSource("src/lib/y.ts", "const y = d.getUTCFullYear();")).toEqual([]);
  });

  it("scanRepo reads a NUL-byte file from disk and finds the planted copy", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-guard-"));
    mkdirSync(join(root, "src/lib"), { recursive: true });
    writeFileSync(
      join(root, "src/lib/nul.ts"),
      Buffer.from(`const S = "\0";\n${TEMPLATE}\n`, "utf8")
    );
    writeFileSync(join(root, "src/lib/clean.ts"), "export const ok = 1;\n");
    const { files, offences } = scanRepo(root);
    expect(files).toBe(2);
    expect(offences.map((o) => `${o.file}:${o.rule}`)).toEqual(["src/lib/nul.ts:template"]);
  });

  it("the real repo is clean", () => {
    expect(scanRepo(join(__dirname, "../../..")).offences).toEqual([]);
  });
});
