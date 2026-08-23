/**
 * OPE-254 — a resolved held-photo reply must NOT be parked behind the
 * correction lane's admin-decision pause.
 *
 * `correction` normally hibernates on a 7-day `waitForEvent` before replying,
 * because most corrections want a human's wording. After that gate the workflow
 * rebuilds `result` wholesale:
 *
 *     result = { replyKind: decisionToReplyKind(intent, decision), ... }
 *
 * which discards whatever the handler returned. So a reply naming the fair would
 * attach its photos in seconds and then tell nobody for up to a week, with
 * `reply_kind` overwritten to a generic ack and `resulting_event_id` dropped —
 * the same "we told the user to do X, they did X, nothing happened" shape this
 * ticket exists to close.
 *
 * The handler opts out via `skipAdminDecision`. This pins that it does, because
 * the flag is invisible in prod until someone waits seven days for an
 * acknowledgement.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveHeldPhotosFromReply = vi.fn();
vi.mock("../src/photo/resolve-held-photos.js", () => ({
  resolveHeldPhotosFromReply: (...a: unknown[]) => resolveHeldPhotosFromReply(...a),
}));

const { handle } = await import("../src/email-handlers/correction.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ROW: any = {
  id: "row-1",
  subject: "Re: Phillips Old Home Days",
  bodyTextExcerpt: "This photo is from Phillips Old Home Days in Phillips, Maine",
  fromAddress: "jtarboxme@gmail.com",
  inReplyTo: "<notification@meetmeatthefair.com>",
  emailReferences: "<original@mail.gmail.com>",
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CTX: any = { sessionId: "s-1", senderTrust: "trusted", emailAuth: "pass" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENV: any = { DB: {} };

beforeEach(() => resolveHeldPhotosFromReply.mockReset());

describe("correction handler — held-photo branch", () => {
  it("declines the admin-decision pause when photos were resolved", async () => {
    resolveHeldPhotosFromReply.mockResolvedValue({
      event: {
        id: "e-1",
        name: "Phillips Old Home Days 2026",
        slug: "phillips-old-home-days-2026",
      },
      parentCount: 1,
      resolvedParents: 1,
      attached: 1,
      failed: 0,
    });

    const out = await handle(ENV, CTX, ROW);

    expect(out.replyKind).toBe("photo-intake-resolved");
    expect(out.resultingEventId).toBe("e-1");
    // The load-bearing assertion: without this the workflow overwrites
    // everything above with a generic correction-ack, seven days later.
    expect(out.skipAdminDecision).toBe(true);
  });

  it("reports the attach counts back to the sender", async () => {
    resolveHeldPhotosFromReply.mockResolvedValue({
      event: {
        id: "e-1",
        name: "Phillips Old Home Days 2026",
        slug: "phillips-old-home-days-2026",
      },
      parentCount: 3,
      resolvedParents: 3,
      attached: 8,
      failed: 1,
    });

    const out = await handle(ENV, CTX, ROW);

    expect(out.replyParams).toMatchObject({
      resolvedEventName: "Phillips Old Home Days 2026",
      photoCount: 8,
      galleryFailed: 1,
      emailCount: 3,
    });
  });
});
