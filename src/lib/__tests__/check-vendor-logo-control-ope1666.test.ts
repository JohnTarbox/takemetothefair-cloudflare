/**
 * OPE-1666 — the vendor logo control guard (scripts/check-vendor-logo-control.ts).
 *
 * Fixtures are excerpts in the shape the production build minifies to (copied
 * from the real `/vendor/profile` page chunk, 2026-11-17). The gallery case is
 * the one that matters most: the gallery ships its own image file input on the
 * same page, so a guard that only looked for "a file input" would pass with the
 * logo control gone.
 */
import { describe, it, expect } from "vitest";
import {
  checkBundle,
  loadPageChunks,
  manifestPathFor,
} from "../../../scripts/check-vendor-logo-control";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LOGO_CONTROL =
  '(0,s.jsx)(d.A,{className:"h-4 w-4","aria-hidden":"true"}),m?"Replace logo":"Upload logo",' +
  '(0,s.jsx)("input",{type:"file",accept:"image/jpeg,image/png,image/webp",className:"sr-only",disabled:p,onChange:x})';
const UPLOAD =
  'a.append("vendorId",t),a.append("file",e);let s=await fetch("/api/vendor-photos/logo",{method:"POST",body:a})';
const REMOVE =
  'await fetch("/api/vendor-photos/logo",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({vendorId:t})})';
const GALLERY_INPUT =
  '"upload"===g?"Uploading…":"Add a photo",(0,r.jsx)("input",{type:"file",accept:"image/jpeg,image/png,image/webp",className:"sr-only"})';

const names = (texts: string[]) => checkBundle(texts).missing.map((m) => m.name);

describe("checkBundle", () => {
  it("passes when the control and both requests are present, across separate chunks", () => {
    const r = checkBundle([GALLERY_INPUT, LOGO_CONTROL + UPLOAD, REMOVE]);
    expect(r.missing).toEqual([]);
    // Positive landmark: it read what it was given.
    expect(r.chunks).toBe(3);
    expect(r.bytes).toBeGreaterThan(LOGO_CONTROL.length);
  });

  it("fails with only the GALLERY's file input — a file input is not the logo control", () => {
    expect(names([GALLERY_INPUT, UPLOAD, REMOVE])).toEqual(["logo upload control"]);
  });

  it("fails when the label is present but its file input is not", () => {
    const labelOnly = LOGO_CONTROL.replace(/\(0,s\.jsx\)\("input".*$/, "");
    expect(labelOnly).toContain('"Upload logo"');
    expect(names([labelOnly, UPLOAD, REMOVE, GALLERY_INPUT])).toEqual(["logo upload control"]);
  });

  it("fails when the upload or the remove request is missing", () => {
    expect(names([LOGO_CONTROL, REMOVE])).toEqual(["logo upload request"]);
    expect(names([LOGO_CONTROL, UPLOAD])).toEqual(["logo remove request"]);
  });

  it("fails everything on an empty bundle", () => {
    expect(names([])).toHaveLength(3);
  });
});

/** Write a client reference manifest the way Next 16 does: a script assigning into globalThis. */
function writeManifest(dir: string, entries: Record<string, unknown>): void {
  const path = manifestPathFor(dir);
  mkdirSync(dirname(path), { recursive: true });
  const body = Object.entries(entries)
    .map(([k, v]) => `globalThis.__RSC_MANIFEST[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
    .join("\n");
  writeFileSync(path, `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n${body}\n`);
}

describe("loadPageChunks", () => {
  it("throws when there is no build manifest — a guard with nothing to read is a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    expect(() => loadPageChunks(dir)).toThrow(/page_client-reference-manifest\.js not found/);
  });

  it("throws when the manifest has no /vendor/profile entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    writeManifest(dir, { "/some/other/page": { entryJSFiles: {}, clientModules: {} } });
    expect(() => loadPageChunks(dir)).toThrow(/is not in/);
  });

  it("reads exactly the chunks the manifest lists for the page (entry files + client modules)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    mkdirSync(join(dir, "static/chunks"), { recursive: true });
    writeFileSync(join(dir, "static/chunks/a.js"), LOGO_CONTROL);
    writeFileSync(join(dir, "static/chunks/b.js"), UPLOAD + REMOVE);
    writeFileSync(join(dir, "static/chunks/unlisted.js"), "nothing");
    writeManifest(dir, {
      "/vendor/profile/page": {
        entryJSFiles: { "[project]/src/app/vendor/profile/page": ["static/chunks/a.js", "x.css"] },
        // Client-module chunks carry the /_next/ prefix; a.js is listed twice on purpose.
        clientModules: {
          m1: { chunks: ["/_next/static/chunks/b.js", "/_next/static/chunks/a.js"] },
        },
      },
    });
    const texts = loadPageChunks(dir);
    expect(texts).toHaveLength(2);
    expect(checkBundle(texts).missing).toEqual([]);
  });

  it("fails the control check when the page's chunks lack it, even if another chunk has it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    mkdirSync(join(dir, "static/chunks"), { recursive: true });
    writeFileSync(join(dir, "static/chunks/page.js"), UPLOAD + REMOVE);
    writeFileSync(join(dir, "static/chunks/unlisted.js"), LOGO_CONTROL);
    writeManifest(dir, {
      "/vendor/profile/page": { entryJSFiles: { p: ["static/chunks/page.js"] }, clientModules: {} },
    });
    expect(checkBundle(loadPageChunks(dir)).missing.map((m) => m.name)).toEqual([
      "logo upload control",
    ]);
  });
});
