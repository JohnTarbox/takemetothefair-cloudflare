/**
 * OPE-597 — a tool description that contradicts the code it describes.
 *
 * `get_event_details_admin` claimed it reads "PENDING, TENTATIVE and REJECTED
 * rows that get_event_details filters out … the public reader reports those as
 * 'not found'."
 *
 * TENTATIVE is not one of them. `get_event_details` applies
 * `publicEventWhere()`, whose editorial half is
 * `PUBLIC_EVENT_STATUSES = [APPROVED, TENTATIVE]` — so the public reader serves
 * TENTATIVE rows in full, and the public category pages render them badged.
 *
 * ── Why this is worth a test and not just an edit ──────────────────────────
 * The sentence was not decorative. It cost OPE-583 four tool calls of reasoning
 * built on "the 121 annual_rollover rows are invisible to the public, therefore
 * forward coverage really is 11 events". The truth is the opposite — 94 events
 * are served for May–Aug 2027, and those rollover rows carry projected,
 * unverified dates that are LIVE on the site. "We have nothing" and "we are
 * publishing guesses" are opposite operational situations, and the description
 * pointed at the wrong one.
 *
 * So the guard is a consistency check between the prose and the constant. If
 * someone later removes TENTATIVE from PUBLIC_EVENT_STATUSES, this fails and
 * forces the description to be revisited in the same change — which is exactly
 * what did not happen last time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PUBLIC_EVENT_STATUSES } from "@takemetothefair/constants";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/tools/admin-event-read.ts", import.meta.url)),
  "utf8"
);

/** Just the description string of get_event_details_admin. */
function description(): string {
  const start = SRC.indexOf('"get_event_details_admin"');
  expect(start).toBeGreaterThan(-1);
  const body = SRC.slice(start, start + 3000);
  return body;
}

describe("OPE-597 — the description matches the predicate", () => {
  const desc = description();

  it("the public gate really does include TENTATIVE — the fact the prose got wrong", () => {
    expect([...PUBLIC_EVENT_STATUSES]).toContain("TENTATIVE");
    expect([...PUBLIC_EVENT_STATUSES]).toContain("APPROVED");
  });

  it("the description no longer lists TENTATIVE among what the public reader hides", () => {
    // The original sentence, which must not come back.
    expect(desc).not.toContain(
      "PENDING, TENTATIVE and REJECTED rows that get_event_details filters out"
    );
  });

  it("says explicitly that TENTATIVE IS served, rather than going quiet about it", () => {
    // Scope 4: "if PENDING/REJECTED behave as documented, say so explicitly
    // rather than leaving the sentence half-true." Silence would leave a reader
    // with the old assumption intact.
    expect(desc).toMatch(/TENTATIVE is NOT one of them/i);
    expect(desc).toMatch(/SERVES TENTATIVE/i);
  });

  it("names the real gate rather than describing it vaguely", () => {
    expect(desc).toContain("publicEventWhere()");
    expect(desc).toContain("APPROVED, TENTATIVE");
  });

  it("records the list/detail answer scope 3 asked for", () => {
    // Established structurally: isPublicEventStatus() delegates to
    // publicEventWhere(), so the two agree by construction, not by coincidence.
    expect(desc).toMatch(/isPublicEventStatus\(\) delegates to it/);
  });

  it("still tells the truth about the statuses that ARE hidden", () => {
    for (const s of ["PENDING", "DRAFT", "REJECTED"]) {
      expect(desc).toContain(s);
      expect([...PUBLIC_EVENT_STATUSES]).not.toContain(s);
    }
  });
});
