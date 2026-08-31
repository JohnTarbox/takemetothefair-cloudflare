import { describe, it, expect } from "vitest";
import { buildReply } from "../src/email-reply-builder.js";

/**
 * OPE-205 §1 — the photo ack must itemize what was WRITTEN, not just staged.
 *
 * The defect this closes is a producer/consumer gap. `photo-intake.ts` has been
 * sending `autoCreated` / `autoLinked` / `autoFailed` / `autoWrittenNames`
 * since OPE-204 Milestone B landed, and the reply builder dropped all four.
 *
 * That costs nothing while `PHOTO_AUTOWRITE_ENABLED` is "false" and becomes a
 * lie the moment it flips: the old copy said flatly "nothing has been added to
 * the site yet", which would have gone out beside vendors the same run had
 * just created.
 */
const BASE = {
  subject: "Photos from the fair",
  photoCount: 3,
  resolvedEventName: "Fryeburg Fair",
  matchMethod: "venue proximity",
  matchedDate: "2026-10-04",
};

const body = (params: Record<string, unknown>) =>
  buildReply("photo-intake-ack", "john@example.com", { ...BASE, ...params }).text ?? "";

describe("photo ack itemization (OPE-205 §1)", () => {
  it("still says nothing was added when nothing was", () => {
    // Identify-only mode — the state prod is in today. This copy was correct
    // and must stay correct.
    const text = body({ boothsStaged: 2, boothNames: ["Piggy Sue's", "Aehko"] });
    expect(text).toContain("We spotted 2 booths");
    expect(text).toContain("held for review");
    expect(text).toContain("not added yet");
  });

  it("does NOT claim nothing was added when vendors WERE created", () => {
    // THE regression. With autowrite on, the old sentence went out unchanged.
    const text = body({ boothsStaged: 0, autoCreated: 2, autoWrittenNames: ["A", "B"] });
    expect(text).not.toContain("not added yet");
    expect(text).not.toContain("held for review");
    expect(text).toContain("2 new vendors added");
  });

  it("separates newly created from existing-now-linked", () => {
    const text = body({ autoCreated: 1, autoLinked: 3, autoWrittenNames: ["A"] });
    expect(text).toContain("1 new vendor added");
    expect(text).toContain("3 existing vendors linked to this fair");
  });

  it("reports both written and still-held in one reply", () => {
    const text = body({ boothsStaged: 2, autoCreated: 1, autoWrittenNames: ["A"] });
    expect(text).toContain("1 new vendor added");
    expect(text).toContain("2 more are held for review");
  });

  it("REPORTS a booth it recognised but failed to write", () => {
    // The case most worth hearing about: from the outside a failed write is
    // indistinguishable from "not recognised", so silence would be misread as
    // "the photo was no good" rather than "we broke".
    const text = body({ autoCreated: 1, autoFailed: 2, autoWrittenNames: ["A"] });
    expect(text).toContain("2 booths could not be saved");
  });

  it("counts written booths in the spotted total", () => {
    // `staged` alone under-reports once autowrite is on — a run that wrote 3
    // and staged 1 would have said "We spotted 1 booth".
    const text = body({ boothsStaged: 1, autoCreated: 3, autoWrittenNames: ["A", "B", "C"] });
    expect(text).toContain("We spotted 4 booths");
  });

  it("names the written booths, not only the staged ones", () => {
    const text = body({ boothsStaged: 0, autoCreated: 1, autoWrittenNames: ["Piggy Sue's"] });
    expect(text).toContain("Piggy Sue's");
  });

  it("says nothing about booths when the vision pass found none", () => {
    // No empty "We spotted 0 booths." line on the ~all emails with no booths.
    const text = body({ boothsStaged: 0 });
    expect(text).not.toContain("We spotted");
    expect(text).not.toContain("held for review");
  });

  it("keeps singular/plural honest at every boundary", () => {
    expect(body({ autoCreated: 1, autoWrittenNames: ["A"] })).toContain("1 new vendor added");
    expect(body({ autoCreated: 2, autoWrittenNames: ["A"] })).toContain("2 new vendors added");
    expect(body({ boothsStaged: 1 })).toContain("This is held for review");
    expect(body({ boothsStaged: 2 })).toContain("These are held for review");
    expect(body({ autoFailed: 1 })).toContain("1 booth could not be saved");
  });

  it("tells John when a photo could not be identified", () => {
    // Previously this landed only in a discrepancy row he had to go find. From
    // his side an unreadable photo is indistinguishable from one we ignored.
    const text = body({ photosUnidentified: 2 });
    expect(text).toContain("could not make out 2 photos");
    expect(text).toContain("reply with the name");
  });

  it("says nothing about unidentified photos when every one was read", () => {
    expect(body({ boothsStaged: 1, photosUnidentified: 0 })).not.toContain("could not make out");
  });

  it("still states the matched fair and date", () => {
    // The itemization must not have displaced what the reply already got right.
    const text = body({ autoCreated: 1, autoWrittenNames: ["A"] });
    expect(text).toContain("Fryeburg Fair");
    expect(text).toContain("2026-10-04");
  });
});
