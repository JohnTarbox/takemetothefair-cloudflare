/**
 * OPE-68 — receive-time attachment capture (email-handler.captureAttachments).
 *
 * The full handleInboundEmail flow needs PostalMime + ForwardableEmailMessage
 * + the workflow binding mocked (see the note at the top of
 * email-handler.test.ts), so we unit-test the extracted, exported
 * `captureAttachments` helper directly with a mocked R2 bucket. It carries the
 * whole best-effort contract: it never throws, individual put failures are
 * isolated, non-media attachments are skipped, and a missing bucket no-ops.
 *
 * The best-effort proof for ingestion is: when a put throws, captureAttachments
 * returns [] (→ attachment_refs stays null and the surrounding entrypoint
 * try/catch never sees an exception), so ingestion proceeds exactly as before.
 */
import { describe, expect, it, vi } from "vitest";
import { captureAttachments, type AttachmentRef } from "../src/email-handler.js";

interface PutCall {
  key: string;
  bytesLen: number;
  contentType?: string;
}

/** Minimal R2 bucket mock recording put()s. `throwOn` forces put to throw for
 *  keys whose suffix matches, to exercise the per-attachment best-effort catch. */
function mockBucket(opts: { throwAlways?: boolean } = {}) {
  const puts: PutCall[] = [];
  const bucket = {
    put: vi.fn(async (key: string, value: ArrayBuffer | ArrayBufferView, options?: unknown) => {
      if (opts.throwAlways) throw new Error("R2 put failed");
      const len =
        value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
      const contentType = (options as { httpMetadata?: { contentType?: string } } | undefined)
        ?.httpMetadata?.contentType;
      puts.push({ key, bytesLen: len, contentType });
      return {} as unknown;
    }),
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(n).fill(65);
}

describe("captureAttachments — media selection + refs", () => {
  it("stores image + PDF attachments and returns refs with key/name/mimeType/size", async () => {
    const { bucket, puts } = mockBucket();
    const refs = await captureAttachments(bucket, "grp1", [
      { filename: "poster.png", mimeType: "image/png", content: bytes(120) },
      { filename: "flyer.pdf", mimeType: "application/pdf", content: bytes(300) },
    ]);
    expect(refs).toHaveLength(2);
    expect(puts).toHaveLength(2);
    const png = refs.find((r) => r.mimeType === "image/png") as AttachmentRef;
    expect(png.key).toBe("inbound-attachments/grp1/0-poster.png");
    expect(png.size).toBe(120);
    expect(png.name).toBe("poster.png");
    const pdf = refs.find((r) => r.mimeType === "application/pdf") as AttachmentRef;
    expect(pdf.key).toBe("inbound-attachments/grp1/1-flyer.pdf");
    // Content-Type is carried into R2 metadata so the OCR step can read it back.
    expect(puts[0].contentType).toBe("image/png");
  });

  it("skips non-image / non-PDF attachments (docx, calendar, etc.)", async () => {
    const { bucket, puts } = mockBucket();
    const refs = await captureAttachments(bucket, "grp2", [
      {
        filename: "agenda.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: bytes(100),
      },
      { filename: "invite.ics", mimeType: "text/calendar", content: bytes(100) },
      { filename: "poster.jpg", mimeType: "image/jpeg", content: bytes(100) },
    ]);
    // Only the image is stored.
    expect(refs).toHaveLength(1);
    expect(refs[0].mimeType).toBe("image/jpeg");
    expect(puts).toHaveLength(1);
  });

  it("caps at the first 5 image/PDF attachments", async () => {
    const { bucket } = mockBucket();
    const many = Array.from({ length: 8 }, (_, i) => ({
      filename: `p${i}.png`,
      mimeType: "image/png",
      content: bytes(50),
    }));
    const refs = await captureAttachments(bucket, "grp3", many);
    expect(refs).toHaveLength(5);
  });

  it("skips attachments over the 10 MB per-file cap", async () => {
    const { bucket, puts } = mockBucket();
    const refs = await captureAttachments(bucket, "grp4", [
      { filename: "huge.png", mimeType: "image/png", content: bytes(10 * 1024 * 1024 + 1) },
      { filename: "ok.png", mimeType: "image/png", content: bytes(500) },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("ok.png");
    expect(puts).toHaveLength(1);
  });
});

describe("captureAttachments — best-effort isolation", () => {
  it("returns [] (never throws) when a put throws — ingestion proceeds unaffected", async () => {
    const { bucket } = mockBucket({ throwAlways: true });
    // Must NOT reject: the whole point is that a storage failure can't bubble
    // into the email entrypoint and block ingestion.
    const refs = await captureAttachments(bucket, "grp5", [
      { filename: "poster.png", mimeType: "image/png", content: bytes(200) },
    ]);
    expect(refs).toEqual([]);
  });

  it("no-ops (returns []) when the bucket binding is absent (tests / non-R2 env)", async () => {
    const refs = await captureAttachments(undefined, "grp6", [
      { filename: "poster.png", mimeType: "image/png", content: bytes(200) },
    ]);
    expect(refs).toEqual([]);
  });

  it("returns [] for empty / missing attachment lists", async () => {
    const { bucket } = mockBucket();
    expect(await captureAttachments(bucket, "grp7", [])).toEqual([]);
    expect(await captureAttachments(bucket, "grp7", undefined)).toEqual([]);
  });

  it("sanitizes unsafe filenames into the R2 key", async () => {
    const { bucket } = mockBucket();
    const refs = await captureAttachments(bucket, "grp8", [
      { filename: "my poster (final)!!.png", mimeType: "image/png", content: bytes(50) },
    ]);
    expect(refs[0].key).toBe("inbound-attachments/grp8/0-my-poster-final-.png");
  });
});
