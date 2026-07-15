/**
 * OPE-202 — photos@ intake lane: routing (incl. plus-addressing), the
 * auth/trust gate in the handler, and the ack/held replies.
 */
import { describe, it, expect } from "vitest";
import { resolveIntent, parsePlusSegment, shouldForwardToAdmin } from "../src/email-intents.js";
import { handle as handlePhotoIntake } from "../src/email-handlers/photo-intake.js";
import { buildReply } from "../src/email-reply-builder.js";
import type { HandlerCtx } from "../src/email-handlers/types.js";

const ctx = (
  emailAuth: "pass" | "fail" | "unknown",
  senderTrust: "trusted" | "watchlist" | "blocked" | "unknown"
): HandlerCtx => ({ sessionId: "wf-1", emailAuth, senderTrust });

// Minimal InboundEmail-shaped row (only the fields the handler reads).
const row = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    toAddress: "photos@meetmeatthefair.com",
    subject: "booth pics",
    attachmentCount: 3,
    attachmentRefs: null,
    ...over,
  }) as never;

const refs = (mimes: string[]) =>
  JSON.stringify(mimes.map((m, i) => ({ key: `k${i}`, name: `p${i}`, mimeType: m, size: 10 })));

describe("photo-intake routing (OPE-202)", () => {
  it("routes photos@ to photo_intake", () => {
    expect(resolveIntent("photos@meetmeatthefair.com")).toBe("photo_intake");
  });
  it("routes plus-addressed photos+<slug>@ to photo_intake (sub-address stripped)", () => {
    expect(resolveIntent("photos+summer-fair-2026@meetmeatthefair.com")).toBe("photo_intake");
    expect(resolveIntent("Photos+Summer@MeetMeAtTheFair.com")).toBe("photo_intake");
  });
  it("parses the +slug event hint", () => {
    expect(parsePlusSegment("photos+summer-fair-2026@meetmeatthefair.com")).toBe(
      "summer-fair-2026"
    );
    expect(parsePlusSegment("photos@meetmeatthefair.com")).toBeNull();
  });
  it("does not forward photo_intake to the admin Gmail (like submit)", () => {
    expect(shouldForwardToAdmin("photo_intake")).toBe(false);
    expect(shouldForwardToAdmin("support")).toBe(true);
  });
});

describe("photo-intake handler gate (OPE-202)", () => {
  it("authenticated + trusted → photo-intake-ack, eligible", async () => {
    const res = await handlePhotoIntake({} as never, ctx("pass", "trusted"), row());
    expect(res.replyKind).toBe("photo-intake-ack");
    expect(res.status).toBe("replied");
    expect(res.replyParams?.photoCount).toBe(3);
  });

  it("auth fail → held", async () => {
    const res = await handlePhotoIntake({} as never, ctx("fail", "trusted"), row());
    expect(res.replyKind).toBe("photo-intake-held");
  });

  it("untrusted sender (even if auth passes) → held", async () => {
    const res = await handlePhotoIntake({} as never, ctx("pass", "unknown"), row());
    expect(res.replyKind).toBe("photo-intake-held");
  });

  it("counts image attachments from refs + surfaces the +slug hint", async () => {
    const res = await handlePhotoIntake(
      {} as never,
      ctx("pass", "trusted"),
      row({
        toAddress: "photos+blue-hill-fair@meetmeatthefair.com",
        attachmentCount: 4,
        attachmentRefs: refs(["image/jpeg", "image/png", "application/pdf", "image/heic"]),
      })
    );
    expect(res.replyParams?.photoCount).toBe(3); // 3 images, PDF excluded
    expect(res.replyParams?.eventHint).toBe("blue-hill-fair");
  });
});

describe("photo-intake replies (OPE-202)", () => {
  it("ack reply names the count + carries the EXIF full-size tip", () => {
    const msg = buildReply("photo-intake-ack", "j@example.com", {
      subject: "pics",
      photoCount: 3,
      eventHint: "summer-fair",
    });
    expect(msg.text).toContain("received 3 photos");
    expect(msg.text.toLowerCase()).toContain("full size");
    expect(msg.text).toContain("summer-fair");
  });

  it("held reply explains the hold + keeps the EXIF tip", () => {
    const msg = buildReply("photo-intake-held", "j@example.com", { photoCount: 1 });
    expect(msg.text).toContain("received 1 photo");
    expect(msg.text.toLowerCase()).toContain("review");
    expect(msg.text.toLowerCase()).toContain("full size");
  });
});
