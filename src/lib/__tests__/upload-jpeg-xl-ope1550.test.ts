/**
 * OPE-1550 — every main-app upload path refuses JPEG XL by its BYTES and names
 * it. The pipeline (`runUploadPipeline`) needs R2 + D1 + Image Resizing, so the
 * gate it runs first is pinned here directly: `validateImageBytes` is the same
 * function the pipeline and the two legacy admin routes
 * (`/api/admin/events/[id]/upload-image`, `/api/admin/vendors/[id]/upload-logo`)
 * now call, and those two used to trust the browser's `file.type` alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeRefusedDeclaredType,
  describeRefusedImageBytes,
  validateImageBytes,
  PIPELINE_ALLOWED_TYPES,
} from "../upload-image-pipeline";
import {
  identifyUnsupportedImageFormat,
  unsupportedImageFormatForMime,
} from "@takemetothefair/utils";

const sig = (head: number[]) => {
  const b = new Uint8Array(200).fill(0x41);
  b.set(head, 0);
  return b;
};
const JXL_CODESTREAM = sig([0xff, 0x0a]);
const JXL_CONTAINER = sig([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
const JPEG = sig([0xff, 0xd8, 0xff, 0xe0]);
const PNG = sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AVIF = sig([0, 0, 0, 0x1c, ...new TextEncoder().encode("ftypavif")]);
const TIFF = sig([0x49, 0x49, 0x2a, 0x00]);

describe("identifyUnsupportedImageFormat", () => {
  it.each([
    ["JXL codestream", JXL_CODESTREAM, "image/jxl"],
    ["JXL container", JXL_CONTAINER, "image/jxl"],
    ["AVIF", AVIF, "image/avif"],
    ["TIFF", TIFF, "image/tiff"],
  ])("names %s", (_l, bytes, mime) => {
    expect(identifyUnsupportedImageFormat(bytes)?.mime).toBe(mime);
  });

  it.each([
    ["JPEG", JPEG],
    ["PNG", PNG],
    ["filler", new Uint8Array(64).fill(7)],
    ["too short", new Uint8Array([0xff])],
  ])("returns null for %s — it never names an accepted or unknown file", (_l, bytes) => {
    expect(identifyUnsupportedImageFormat(bytes)).toBeNull();
  });

  it("maps a declared image/jxl (with parameters, any case) and ignores accepted types", () => {
    expect(unsupportedImageFormatForMime("Image/JXL; q=1")?.mime).toBe("image/jxl");
    for (const t of PIPELINE_ALLOWED_TYPES) expect(unsupportedImageFormatForMime(t)).toBeNull();
  });
});

describe("validateImageBytes — the gate the pipeline AND the legacy routes run", () => {
  it.each([
    ["honestly declared", "image/jxl", JXL_CONTAINER],
    ["renamed .jpg (browser types it image/jpeg)", "image/jpeg", JXL_CODESTREAM],
    ["renamed .png", "image/png", JXL_CONTAINER],
  ])("refuses JXL %s, naming JPEG XL", (_l, declared, bytes) => {
    const err = validateImageBytes(bytes, declared);
    expect(err).toContain("JPEG XL (.jxl)");
    expect(err).toContain("JPEG, PNG or WebP");
  });

  it("passes a real JPEG declared as one (positive landmark — the gate is not refuse-everything)", () => {
    expect(validateImageBytes(JPEG, "image/jpeg")).toBeNull();
    expect(validateImageBytes(JPEG, "image/jpg")).toBeNull();
  });

  it("still reports a plain mismatch between two accepted formats", () => {
    expect(validateImageBytes(PNG, "image/jpeg")).toMatch(/declared "image\/jpeg".*"image\/png"/);
  });

  it("keeps the generic text for bytes it can't name", () => {
    expect(describeRefusedImageBytes(new Uint8Array(64).fill(7))).toBe(
      "File bytes don't match any supported image format"
    );
  });
});

describe("describeRefusedDeclaredType — the declared-type refusal every route shares", () => {
  it("names JPEG XL for image/jxl", () => {
    expect(describeRefusedDeclaredType("image/jxl")).toContain("JPEG XL (.jxl)");
  });
  it("keeps the old text for an unknown type", () => {
    expect(describeRefusedDeclaredType("application/zip")).toBe(
      'Unsupported content_type "application/zip". Allowed: jpg/png/webp/svg.'
    );
  });
});

describe("structural: no upload route stores bytes it has not sniffed", () => {
  // The two legacy routes put `file.arrayBuffer()` straight into R2. Pin that
  // each now calls validateImageBytes BEFORE its bucket.put — the call
  // syntax, not the bare symbol, so the import line can't satisfy it.
  it.each([
    "src/app/api/admin/events/[id]/upload-image/route.ts",
    "src/app/api/admin/vendors/[id]/upload-logo/route.ts",
  ])("%s validates bytes before bucket.put", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const check = src.indexOf("validateImageBytes(new Uint8Array(body)");
    const put = src.indexOf("bucket.put(");
    expect(check).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(-1);
    expect(check).toBeLessThan(put);
  });
});
