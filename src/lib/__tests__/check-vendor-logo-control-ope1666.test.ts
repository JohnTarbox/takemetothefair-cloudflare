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
import { checkBundle, loadPageChunks } from "../../../scripts/check-vendor-logo-control";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("loadPageChunks", () => {
  it("throws when there is no build manifest — a guard with nothing to read is a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    expect(() => loadPageChunks(dir)).toThrow(/app-build-manifest\.json not found/);
  });

  it("throws when the manifest has no /vendor/profile entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    writeFileSync(join(dir, "app-build-manifest.json"), JSON.stringify({ pages: {} }));
    expect(() => loadPageChunks(dir)).toThrow(/is not in/);
  });

  it("reads exactly the chunks the manifest lists for the page", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope1666-"));
    mkdirSync(join(dir, "static/chunks"), { recursive: true });
    writeFileSync(join(dir, "static/chunks/a.js"), LOGO_CONTROL);
    writeFileSync(join(dir, "static/chunks/b.js"), UPLOAD + REMOVE);
    writeFileSync(join(dir, "static/chunks/unlisted.js"), "nothing");
    writeFileSync(
      join(dir, "app-build-manifest.json"),
      JSON.stringify({
        pages: { "/vendor/profile/page": ["static/chunks/a.js", "static/chunks/b.js", "x.css"] },
      })
    );
    const texts = loadPageChunks(dir);
    expect(texts).toHaveLength(2);
    expect(checkBundle(texts).missing).toEqual([]);
  });
});
