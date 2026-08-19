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
 * returns no refs (→ attachment_refs stays null and the surrounding entrypoint
 * try/catch never sees an exception), so ingestion proceeds exactly as before.
 *
 * OPE-467 — it now returns `{ refs, skipped }`. The filters below did not
 * change; what changed is that they say so. Every skip carries a reason, and
 * the contract these tests hold it to is:
 *
 *     refs.length + skipped.length === attachments.length
 *
 * That is the whole fix. `submit@` looked like it was losing 30% of its
 * attachments because a deliberate skip and a real loss were indistinguishable
 * from outside the function.
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
    const { refs, skipped } = await captureAttachments(bucket, "grp1", [
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
    // Nothing was dropped, and the record says so positively rather than by
    // the absence of evidence.
    expect(skipped).toEqual([]);
  });

  it("skips non-image / non-PDF attachments (docx, calendar, etc.)", async () => {
    const { bucket, puts } = mockBucket();
    const { refs, skipped } = await captureAttachments(bucket, "grp2", [
      {
        filename: "agenda.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: bytes(100),
      },
      { filename: "invite.ics", mimeType: "text/calendar", content: bytes(100) },
      { filename: "poster.jpg", mimeType: "image/jpeg", content: bytes(100) },
    ]);
    // Only the image is stored — unchanged behaviour.
    expect(refs).toHaveLength(1);
    expect(refs[0].mimeType).toBe("image/jpeg");
    expect(puts).toHaveLength(1);
    // …and the two we chose not to keep are now NAMED, with a reason. A .docx
    // is very often the vendor roster or the application form, so "we skipped
    // it on purpose" is a materially different fact from "it vanished".
    expect(skipped.map((s) => [s.index, s.name, s.reason])).toEqual([
      [0, "agenda.docx", "unsupported-type"],
      [1, "invite.ics", "unsupported-type"],
    ]);
    expect(refs.length + skipped.length).toBe(3);
  });

  it("caps at the first 5 image/PDF attachments", async () => {
    const { bucket } = mockBucket();
    const many = Array.from({ length: 8 }, (_, i) => ({
      filename: `p${i}.png`,
      mimeType: "image/png",
      content: bytes(50),
    }));
    const { refs, skipped } = await captureAttachments(bucket, "grp3", many);
    expect(refs).toHaveLength(5);
    // The live specimens: inbound_emails 2a09ef41 (8 claimed → 5 stored) and
    // 4c536723 (6 → 5), both exactly at the cap, both with the overflow
    // unrecorded. Three real attachments from a craft-show promoter went
    // missing with nothing to show for them.
    expect(skipped).toHaveLength(3);
    expect(skipped.every((s) => s.reason === "over-count-cap")).toBe(true);
    expect(skipped.map((s) => s.index)).toEqual([5, 6, 7]);
    expect(refs.length + skipped.length).toBe(8);
  });

  it("skips attachments over the 10 MB per-file cap", async () => {
    const { bucket, puts } = mockBucket();
    const { refs, skipped } = await captureAttachments(bucket, "grp4", [
      { filename: "huge.png", mimeType: "image/png", content: bytes(10 * 1024 * 1024 + 1) },
      { filename: "ok.png", mimeType: "image/png", content: bytes(500) },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("ok.png");
    expect(puts).toHaveLength(1);
    expect(skipped).toEqual([
      {
        index: 0,
        name: "huge.png",
        mimeType: "image/png",
        size: 10 * 1024 * 1024 + 1,
        reason: "too-large",
      },
    ]);
  });
});

describe("captureAttachments — best-effort isolation", () => {
  it("returns [] (never throws) when a put throws — ingestion proceeds unaffected", async () => {
    const { bucket } = mockBucket({ throwAlways: true });
    // Must NOT reject: the whole point is that a storage failure can't bubble
    // into the email entrypoint and block ingestion.
    const { refs, skipped } = await captureAttachments(bucket, "grp5", [
      { filename: "poster.png", mimeType: "image/png", content: bytes(200) },
    ]);
    expect(refs).toEqual([]);
    // A put failure is the one reason here that is unambiguously a fault
    // rather than a policy decision, so it must never be silent.
    expect(skipped).toEqual([
      { index: 0, name: "poster.png", mimeType: "image/png", size: 200, reason: "put-failed" },
    ]);
  });

  it("no-ops (stores nothing) when the bucket binding is absent (tests / non-R2 env)", async () => {
    const { refs, skipped } = await captureAttachments(undefined, "grp6", [
      { filename: "poster.png", mimeType: "image/png", content: bytes(200) },
    ]);
    expect(refs).toEqual([]);
    // Still reported: the sender did attach this, and a missing binding is our
    // problem, not a reason for the record to say nothing arrived.
    expect(skipped).toHaveLength(1);
  });

  it("returns nothing for empty / missing attachment lists", async () => {
    const { bucket } = mockBucket();
    expect(await captureAttachments(bucket, "grp7", [])).toEqual({ refs: [], skipped: [] });
    expect(await captureAttachments(bucket, "grp7", undefined)).toEqual({ refs: [], skipped: [] });
  });

  it("sanitizes unsafe filenames into the R2 key", async () => {
    const { bucket } = mockBucket();
    const { refs, skipped } = await captureAttachments(bucket, "grp8", [
      { filename: "my poster (final)!!.png", mimeType: "image/png", content: bytes(50) },
    ]);
    expect(refs[0].key).toBe("inbound-attachments/grp8/0-my-poster-final-.png");
    expect(skipped).toEqual([]);
  });
});

/**
 * OPE-467 — the invariant that turns "we kept fewer than arrived" from a
 * subtraction somebody has to think to do into a checkable statement.
 *
 * `submit@` lost attachments for three months. Nothing was broken enough to
 * throw; the filters simply never said what they had done, so
 * `attachment_count > len(attachment_refs)` was indistinguishable from a bug
 * and nobody looked. It was found by hand-diffing two columns.
 */
describe("everything handed in is accounted for", () => {
  const cases: Array<{ label: string; input: Parameters<typeof captureAttachments>[2] }> = [
    {
      label: "the 4c536723 shape — 6 media parts, cap at 5",
      input: Array.from({ length: 6 }, (_, i) => ({
        filename: `p${i}.pdf`,
        mimeType: "application/pdf",
        content: bytes(100),
      })),
    },
    {
      label: "the 34b06089 shape — an unsupported part ahead of a real one",
      input: [
        { filename: "roster.xlsx", mimeType: "application/vnd.ms-excel", content: bytes(100) },
        { filename: "flyer.png", mimeType: "image/png", content: bytes(100) },
      ],
    },
    {
      label: "a mixture of every skip reason at once",
      input: [
        { filename: "a.png", mimeType: "image/png", content: bytes(50) },
        { filename: "b.docx", mimeType: "application/msword", content: bytes(50) },
        { filename: "c.png", mimeType: "image/png", content: bytes(10 * 1024 * 1024 + 1) },
        { filename: "d.png", mimeType: "image/png", content: new Uint8Array(0) },
        { filename: "e.pdf", mimeType: "application/pdf", content: bytes(50) },
        { filename: "f.pdf", mimeType: "application/pdf", content: bytes(50) },
        { filename: "g.pdf", mimeType: "application/pdf", content: bytes(50) },
        { filename: "h.pdf", mimeType: "application/pdf", content: bytes(50) },
        { filename: "i.pdf", mimeType: "application/pdf", content: bytes(50) },
      ],
    },
  ];

  for (const c of cases) {
    it(`accounts for every part — ${c.label}`, async () => {
      const { bucket } = mockBucket();
      const { refs, skipped } = await captureAttachments(bucket, "inv", c.input);
      expect(refs.length + skipped.length).toBe(c.input!.length);
      // Every skip is explained; a reasonless skip is the thing being fixed.
      expect(skipped.every((s) => typeof s.reason === "string" && s.reason.length > 0)).toBe(true);
      // Indices are unique and in range, so a skip lines up against the stored
      // R2 keys (which embed the same index).
      const idx = [
        ...refs.map((r) => Number(r.key.split("/").pop()!.split("-")[0])),
        ...skipped.map((s) => s.index),
      ];
      expect(new Set(idx).size).toBe(c.input!.length);
    });
  }

  it("stores the earliest media parts, not an arbitrary five", async () => {
    // The cap takes the FIRST five that pass the media filter — so a
    // non-media part ahead of them does not consume a slot.
    const { bucket } = mockBucket();
    const { refs, skipped } = await captureAttachments(bucket, "order", [
      { filename: "sig.ics", mimeType: "text/calendar", content: bytes(10) },
      ...Array.from({ length: 6 }, (_, i) => ({
        filename: `p${i}.png`,
        mimeType: "image/png",
        content: bytes(50),
      })),
    ]);
    expect(refs).toHaveLength(5);
    expect(skipped.map((s) => s.reason).sort()).toEqual(["over-count-cap", "unsupported-type"]);
  });
});
