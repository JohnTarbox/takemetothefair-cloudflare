/**
 * OPE-760 — the attachment cap must be content-aware before it is
 * content-limited.
 *
 * ── The specimen ───────────────────────────────────────────────────────────
 * Inbound `ce16f4a1` (jeremy.hall@ct.gov → hello@, "Chowdafest Westport
 * Sherwood Island CT"): six attachments, ALL Outlook signature graphics —
 * a 24,897 B CT DEEP logo and five social icons at 498–1,083 B. Five stored,
 * the sixth skipped `over-count-cap`.
 *
 * Nothing of value was lost that time. The defect is that nothing about the
 * mechanism made that luck rather than design: the cap filled in ARRIVAL
 * ORDER, so the same signature block in front of a real poster loses the
 * poster.
 *
 * ── The root cause was a type, not a loop ─────────────────────────────────
 * `CapturableAttachment` carried only `{filename, mimeType, content}`.
 * PostalMime supplies `contentId`, `disposition` and `related` on every
 * attachment and all three were discarded at this boundary — so the cap could
 * not have been content-aware even in principle.
 */
import { describe, it, expect } from "vitest";
import { captureAttachments, isSignatureFurniture } from "../src/email-handler.js";

/** An R2 stub that records what was actually stored. */
function bucketStub() {
  const puts: string[] = [];
  return {
    puts,
    bucket: {
      put: async (key: string) => {
        puts.push(key);
      },
    } as unknown as R2Bucket,
  };
}

const bytes = (n: number) => new Uint8Array(n).buffer;

/** An Outlook signature icon: cid-referenced, inline, tiny. */
const icon = (i: number, size = 600) => ({
  filename: `image00${i}.png`,
  mimeType: "image/png",
  content: bytes(size),
  contentId: `<image00${i}@01DB.OUTLOOK>`,
  disposition: "inline" as const,
  related: true,
});

/** What the sender actually meant to send. */
const poster = (name = "chowdafest-poster.jpg", size = 900_000) => ({
  filename: name,
  mimeType: "image/jpeg",
  content: bytes(size),
  disposition: "attachment" as const,
});

describe("isSignatureFurniture — OPE-760", () => {
  it("classifies the specimen's social icons as furniture", () => {
    for (const size of [498, 600, 713, 1083]) {
      expect(isSignatureFurniture(icon(2, size), size), `size ${size}`).toBe(true);
    }
  });

  it("classifies the specimen's 24,897 B CT DEEP logo as furniture too", () => {
    // The calibration case for the 64 KB threshold — a signature logo is an
    // order of magnitude bigger than the icons around it and still furniture.
    expect(isSignatureFurniture(icon(1, 24_897), 24_897)).toBe(true);
  });

  it("LANDMARK: does NOT classify a real poster as furniture", () => {
    // Without this, a classifier that returns true unconditionally passes
    // every test above — and would deprioritise every attachment we receive.
    expect(isSignatureFurniture(poster(), 900_000)).toBe(false);
  });

  it("needs BOTH signals — small alone is not furniture", () => {
    // A small file a sender deliberately attached is a payload. Plenty of real
    // things are small; only embedded-AND-small is signature furniture.
    expect(isSignatureFurniture({ mimeType: "image/png", disposition: "attachment" }, 600)).toBe(
      false
    );
  });

  it("needs BOTH signals — embedded alone is not furniture", () => {
    // A fair routinely embeds its poster inline in the body. Big-and-inline is
    // the payload, not the decoration.
    expect(isSignatureFurniture({ ...icon(1), mimeType: "image/jpeg" }, 900_000)).toBe(false);
  });

  it("never calls a PDF furniture, whatever its disposition claims", () => {
    expect(
      isSignatureFurniture(
        { mimeType: "application/pdf", contentId: "<x>", disposition: "inline" },
        2_000
      )
    ).toBe(false);
  });
});

describe("captureAttachments — OPE-760 acceptance", () => {
  it("stores the poster that arrives AFTER a six-icon signature block", async () => {
    // The acceptance criterion, in the arrival order that broke it: six icons
    // first, the real file last. Under the old arrival-order cap the poster
    // was attachment #7 and never reached.
    const { bucket } = bucketStub();
    const attachments = [
      icon(1, 24_897),
      icon(2),
      icon(3),
      icon(4),
      icon(5),
      icon(6, 1_083),
      poster(),
    ];

    const { refs, skipped } = await captureAttachments(bucket, "g1", attachments);

    expect(refs.some((r) => r.name.includes("chowdafest-poster"))).toBe(true);
    // And every skip is furniture — the second half of the acceptance.
    expect(skipped.every((s) => s.name.startsWith("image00"))).toBe(true);
  });

  it("keeps the ref/skip contract: nothing vanishes silently", async () => {
    // OPE-467's invariant, restated because the reorder could have broken it:
    // refs + skips must still equal what arrived.
    const { bucket } = bucketStub();
    const attachments = [icon(1), icon(2), icon(3), icon(4), icon(5), icon(6), poster()];
    const { refs, skipped } = await captureAttachments(bucket, "g2", attachments);
    expect(refs.length + skipped.length).toBe(attachments.length);
  });

  it("reports the ORIGINAL arrival index on a skip, despite the reorder", async () => {
    // The reorder must be invisible to anything that keyed on the index —
    // `attachment_skips` entries are matched back to the message by it.
    const { bucket } = bucketStub();
    const attachments = [icon(1), icon(2), icon(3), icon(4), icon(5), icon(6)];
    const { skipped } = await captureAttachments(bucket, "g3", attachments);
    for (const s of skipped) {
      expect(s.name).toBe(`image00${s.index + 1}.png`);
    }
  });

  it("still caps genuine payloads — the quota was raised, not removed", async () => {
    // LANDMARK against the over-correction: "make the poster fit" must not
    // become "store everything", or a pathological sender is unbounded.
    const { bucket } = bucketStub();
    const many = Array.from({ length: 9 }, (_, i) => poster(`file-${i}.jpg`, 100_000 + i));
    const { refs, skipped } = await captureAttachments(bucket, "g4", many);
    expect(refs).toHaveLength(5);
    expect(skipped).toHaveLength(4);
    expect(skipped.every((s) => s.reason === "over-count-cap")).toBe(true);
  });

  it("DISCRIMINATOR (ranking): keeps the LARGEST payload when it arrives last", async () => {
    // Separates the two mechanisms, which are individually sufficient for the
    // headline acceptance case and therefore neither of them tested by it.
    //
    // Seven real payloads, five slots, and the biggest arrives LAST. Arrival
    // order keeps the first five and drops the 900 KB poster; ranking by size
    // keeps it. Reverting the sort fails here and nowhere else.
    const { bucket } = bucketStub();
    const attachments = [
      ...Array.from({ length: 6 }, (_, i) => poster(`small-${i}.jpg`, 1_000 + i)),
      poster("the-actual-poster.jpg", 900_000),
    ];

    const { refs } = await captureAttachments(bucket, "g6", attachments);

    expect(refs.map((r) => r.name)).toContain("the-actual-poster.jpg");
  });

  it("DISCRIMINATOR (dual quota): stores furniture ALONGSIDE a full payload set", async () => {
    // The other half. Five real payloads fill the payload quota exactly, and
    // two icons follow. With separate quotas both icons are stored; with a
    // single shared quota the payloads consume it and the branding vanishes.
    //
    // This is what makes the quotas independent rather than decorative — and
    // it fails, specifically, when furniture is made to share the payload cap.
    const { bucket } = bucketStub();
    const attachments = [
      ...Array.from({ length: 5 }, (_, i) => poster(`real-${i}.jpg`, 500_000 - i)),
      icon(1),
      icon(2),
    ];

    const { refs, skipped } = await captureAttachments(bucket, "g7", attachments);

    expect(refs.filter((r) => r.name.startsWith("real-"))).toHaveLength(5);
    expect(refs.filter((r) => r.name.startsWith("image00"))).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("is unchanged for a message with no signature furniture at all", async () => {
    // The ordinary case must behave exactly as before: three plain
    // attachments, three stored, no skips, no reordering visible.
    const { bucket } = bucketStub();
    const plain = [poster("a.jpg", 300), poster("b.jpg", 200), poster("c.jpg", 100)];
    const { refs, skipped } = await captureAttachments(bucket, "g5", plain);
    expect(refs).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });
});

describe("OPE-760 — the skip records whether it was furniture", () => {
  it("marks a skipped icon as furniture, so a monitor can stay silent about it", async () => {
    // With a furniture quota of 2, a six-icon signature skips four icons on
    // EVERY message from that sender. Without this field the alert built on
    // top would be wallpaper inside a week.
    const { bucket } = bucketStub();
    const { skipped } = await captureAttachments(bucket, "g8", [
      icon(1),
      icon(2),
      icon(3),
      icon(4),
      icon(5),
      icon(6),
    ]);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((k) => k.furniture === true)).toBe(true);
  });

  it("DISCRIMINATOR: marks a skipped real file as NOT furniture", async () => {
    // The case the alert exists for. Six real payloads, five slots — the sixth
    // is a genuine loss and must be distinguishable from an icon.
    const { bucket } = bucketStub();
    const { skipped } = await captureAttachments(
      bucket,
      "g9",
      Array.from({ length: 6 }, (_, i) => poster(`real-${i}.jpg`, 500_000 - i))
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].furniture).toBe(false);
    expect(skipped[0].reason).toBe("over-count-cap");
  });
});
