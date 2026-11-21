/**
 * OPE-1550 — a JPEG XL file must never be stored as something it isn't, and a
 * refusal must say "JPEG XL".
 *
 * Chrome 155 and Firefox 158 open `.jxl` natively, so these will start arriving.
 * Cloudflare's transform can't read JXL as an input, so every MMATF path refuses
 * it. What this pins is HOW: by the bytes (a `.jxl` renamed `.jpg` is typed
 * image/jpeg by the browser) and with the format named.
 *
 * Fixtures are the two spec signatures (ISO/IEC 18181-1 codestream `FF 0A`, and
 * the 18181-2 container's 12-byte `JXL ` box) followed by filler. No path here
 * decodes an image, so a signature is exactly what each gate sees.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { media } from "./helpers/magic-bytes.js";

vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return { ...actual, getDb: () => null };
});

import { captureAttachments } from "../src/email-handler.js";
import { sniffAttachmentType } from "../src/attachment-sniff.js";
import { ingestSnap } from "../src/photo/snap-intake.js";
import { readOperatorQueues } from "../src/operator-queue-notice.js";
import { identifyUnsupportedImageFormat } from "@takemetothefair/utils";
import type { Db } from "../src/db.js";

const JXL_CODESTREAM = (() => {
  const b = new Uint8Array(200).fill(0x41);
  b.set([0xff, 0x0a], 0);
  return b;
})();
const JXL_CONTAINER = (() => {
  const b = new Uint8Array(200).fill(0x41);
  b.set([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a], 0);
  return b;
})();

function memBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    head: async (k: string) => (objects.has(k) ? { key: k } : null),
    put: vi.fn(async (k: string, v: Uint8Array) => {
      objects.set(k, new Uint8Array(v));
      return { key: k };
    }),
  };
  return { bucket, objects };
}

describe("the fixtures are what they claim (positive landmark)", () => {
  it.each([
    ["codestream", JXL_CODESTREAM],
    ["container", JXL_CONTAINER],
  ])("the %s signature is named JPEG XL and is NOT an accepted inbound type", (_l, bytes) => {
    expect(identifyUnsupportedImageFormat(bytes)?.mime).toBe("image/jxl");
    expect(sniffAttachmentType(bytes)).toBeNull();
  });

  it("a real JPEG is not mistaken for JPEG XL (FF D8 vs FF 0A)", () => {
    expect(identifyUnsupportedImageFormat(media("image/jpeg", 64))).toBeNull();
  });
});

describe("inbound capture — a JXL attachment is refused AND named", () => {
  it.each([
    ["declared image/jxl", "image/jxl", JXL_CONTAINER],
    ["renamed .jpg, declared image/jpeg", "image/jpeg", JXL_CODESTREAM],
  ])("%s: nothing stored, skip records detectedFormat image/jxl", async (_l, mimeType, bytes) => {
    const { bucket, objects } = memBucket();
    const { refs, skipped } = await captureAttachments(bucket as unknown as R2Bucket, "g", [
      { filename: "booth.jxl", mimeType, content: bytes },
    ]);
    expect(refs).toEqual([]);
    expect(objects.size).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      reason: "unrecognized-content",
      detectedFormat: "image/jxl",
    });
  });

  it("an unrecognisable blob is still refused, with NO detectedFormat (no false naming)", async () => {
    const { bucket } = memBucket();
    const { skipped } = await captureAttachments(bucket as unknown as R2Bucket, "g", [
      { filename: "x.jpg", mimeType: "image/jpeg", content: new Uint8Array(64).fill(7) },
    ]);
    expect(skipped[0].reason).toBe("unrecognized-content");
    expect(skipped[0].detectedFormat).toBeUndefined();
  });
});

describe("Snap intake — refuses JXL by label AND by bytes, naming it", () => {
  let db: TestDb;
  beforeEach(() => {
    ({ db } = createTestDb());
  });
  const env = () => {
    const { bucket, objects } = memBucket();
    const wf = { create: vi.fn(async () => ({ id: "wf" })) };
    return { env: { VENDOR_ASSETS: bucket as never, INBOUND_EMAIL: wf as never }, objects, wf };
  };

  it("declared image/jxl (the capture page's fallback when the browser can't decode) → 415 naming JPEG XL", async () => {
    const { env: e, objects, wf } = env();
    const res = await ingestSnap(e, db as unknown as Db, {
      bytes: JXL_CONTAINER,
      contentType: "image/jxl",
      meta: { clientId: "3f1c2b9e-8d4a-4c6b-9e2f-1a2b3c4d5e01" },
      actor: "john@example.com",
    });
    expect(res).toMatchObject({ ok: false, status: 415 });
    expect(!res.ok && res.error).toContain("JPEG XL");
    expect(objects.size).toBe(0);
    expect(wf.create).not.toHaveBeenCalled();
  });

  it("JXL bytes declared image/jpeg are refused before any R2 write (they used to be stored as a JPEG)", async () => {
    const { env: e, objects, wf } = env();
    const res = await ingestSnap(e, db as unknown as Db, {
      bytes: JXL_CODESTREAM,
      contentType: "image/jpeg",
      meta: { clientId: "3f1c2b9e-8d4a-4c6b-9e2f-1a2b3c4d5e02" },
      actor: "john@example.com",
    });
    expect(res).toMatchObject({ ok: false, status: 415 });
    expect(!res.ok && res.error).toContain("JPEG XL");
    expect(objects.size).toBe(0);
    expect(wf.create).not.toHaveBeenCalled();
  });

  it("a PNG declared image/jpeg is refused too — the label must match the bytes", async () => {
    const { env: e } = env();
    const res = await ingestSnap(e, db as unknown as Db, {
      bytes: media("image/png", 64),
      contentType: "image/jpeg",
      meta: { clientId: "3f1c2b9e-8d4a-4c6b-9e2f-1a2b3c4d5e03" },
      actor: "john@example.com",
    });
    expect(res).toMatchObject({ ok: false, status: 415 });
    expect(!res.ok && res.error).toContain("image/png");
  });
});

describe("operator notice — a format-refused image reaches a person", () => {
  const NOW = new Date("2026-11-01T06:00:00Z");
  let db: TestDb;
  let raw: ReturnType<typeof createTestDb>["raw"];
  beforeEach(() => {
    ({ db, raw } = createTestDb());
  });
  const at = (ageDays: number) => Math.floor((NOW.getTime() - ageDays * 86400_000) / 1000);
  function seedInbound(id: string, skips: unknown[], ageDays = 1) {
    raw["prepare"](
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, attachment_skips)
       VALUES (?, ?, ?, 'vendor@example.com', 'photos@meetmeatthefair.com', 'photo', ?)`
    ).run(id, at(ageDays), at(ageDays), JSON.stringify(skips));
  }

  it("names the inbound row, the file and the format", async () => {
    seedInbound("ie-jxl", [
      {
        index: 0,
        name: "booth.jxl",
        mimeType: "image/jxl",
        size: 200,
        reason: "unrecognized-content",
        detectedFormat: "image/jxl",
        furniture: false,
      },
    ]);
    const q = await readOperatorQueues(db, NOW);
    expect(q.refusedFormatAttachments).toBe(1);
    expect(q.lines.join("\n")).toMatch(/ie-jxl.*booth\.jxl \[image\/jxl\]/);
  });

  it("stays silent on an unnamed unrecognized-content skip, signature furniture, and rows older than 7 days", async () => {
    seedInbound("ie-svg", [
      {
        index: 0,
        name: "logo.svg",
        mimeType: "image/svg+xml",
        size: 90,
        reason: "unrecognized-content",
        furniture: false,
      },
    ]);
    seedInbound("ie-icon", [
      {
        index: 0,
        name: "icon.jxl",
        mimeType: "image/jxl",
        size: 90,
        reason: "unrecognized-content",
        detectedFormat: "image/jxl",
        furniture: true,
      },
    ]);
    seedInbound(
      "ie-old",
      [
        {
          index: 0,
          name: "old.jxl",
          mimeType: "image/jxl",
          size: 90,
          reason: "unrecognized-content",
          detectedFormat: "image/jxl",
          furniture: false,
        },
      ],
      9
    );
    const q = await readOperatorQueues(db, NOW);
    expect(q.refusedFormatAttachments).toBe(0);
  });
});
