/**
 * OPE-431 — no outbound email may link an event URL for a row that isn't public.
 *
 * The reported incident: a `submit@` acknowledgment told a member of the public
 * their event was "already in our directory" and linked
 * `https://meetmeatthefair.com/events/<slug>`. The matched row was PENDING —
 * created by that same email seconds earlier — so the link had never resolved.
 * The submitter clicked it and got a 404. The claim was false *and* the link
 * was broken.
 *
 * The check already existed in the single-event `already-exists` template, with
 * a comment describing this exact 404. It had simply never been applied to the
 * other renderers. Chasing it down found FOUR unguarded link sites, three of
 * which build the same bullet independently:
 *
 *   1. ok-multi, multi-event single-source   (workflow)
 *   2. ok-multi, multi-candidate fan-out     (workflow)
 *   3. ok-multi, multi-URL pipeline          (workflow, found by TYPESCRIPT —
 *      a third outcome interface a grep for the bullet text had missed)
 *   4. ok-medium-dup `candidateUrl`          (rendered unconditionally)
 *
 * Hence one shared helper rather than a fifth copy of the conditional.
 */
import { describe, it, expect } from "vitest";
import {
  alreadyExistsBullet,
  isEmailableEventStatus,
  publicEventUrlIfVisible,
} from "../src/email-handlers/public-event-url.js";

describe("isEmailableEventStatus", () => {
  it("accepts only the publicly-visible statuses", () => {
    expect(isEmailableEventStatus("APPROVED")).toBe(true);
    expect(isEmailableEventStatus("CONFIRMED")).toBe(true);
  });

  it("rejects PENDING — the status from the reported incident", () => {
    expect(isEmailableEventStatus("PENDING")).toBe(false);
  });

  it("rejects REJECTED, TENTATIVE and DRAFT", () => {
    // TENTATIVE renders publicly on the site but is deliberately excluded
    // here: this gate is "may we put this in an email", and the pre-existing
    // single-event branch already drew the line at APPROVED/CONFIRMED.
    // Widening it is a product decision, not a refactor.
    for (const s of ["REJECTED", "TENTATIVE", "DRAFT", "CANCELLED"]) {
      expect(isEmailableEventStatus(s), s).toBe(false);
    }
  });

  it("fails closed on a missing or empty status", () => {
    // An outcome that forgot to thread status through must NOT produce a link.
    expect(isEmailableEventStatus(undefined)).toBe(false);
    expect(isEmailableEventStatus(null)).toBe(false);
    expect(isEmailableEventStatus("")).toBe(false);
  });
});

describe("publicEventUrlIfVisible", () => {
  it("returns the URL for an approved row", () => {
    expect(publicEventUrlIfVisible("spring-fair-2026", "APPROVED")).toBe(
      "https://meetmeatthefair.com/events/spring-fair-2026"
    );
  });

  it("returns null for a pending row rather than a 404 link", () => {
    expect(publicEventUrlIfVisible("spring-fair-2026", "PENDING")).toBeNull();
  });

  it("returns null when the slug is missing", () => {
    expect(publicEventUrlIfVisible(null, "APPROVED")).toBeNull();
    expect(publicEventUrlIfVisible("", "APPROVED")).toBeNull();
  });
});

describe("alreadyExistsBullet", () => {
  it("links and claims directory membership only when the row is published", () => {
    const bullet = alreadyExistsBullet("Spring Fair", "spring-fair-2026", "APPROVED");
    expect(bullet).toContain("already in our directory");
    expect(bullet).toContain("https://meetmeatthefair.com/events/spring-fair-2026");
  });

  it("makes NO directory claim and emits NO link for a pending match", () => {
    // Both halves matter. The 404 was what got noticed, but "already in our
    // directory" was also simply untrue — the row was not in the directory.
    const bullet = alreadyExistsBullet("Spring Fair", "spring-fair-2026", "PENDING");
    expect(bullet).not.toContain("already in our directory");
    expect(bullet).not.toContain("meetmeatthefair.com");
    expect(bullet).toContain("in review");
  });

  it("still names the event, so the sender can tell which one we matched", () => {
    expect(alreadyExistsBullet("Spring Fair", "s", "PENDING")).toContain("Spring Fair");
  });

  it("degrades safely when the status was never threaded through", () => {
    // The failure mode this guards: a new outcome site forgets `eventStatus`.
    // Undefined must mean "no link", never "link anyway".
    const bullet = alreadyExistsBullet("Spring Fair", "spring-fair-2026", undefined);
    expect(bullet).not.toContain("meetmeatthefair.com");
  });

  it("handles a missing name without emitting 'undefined' to a human", () => {
    expect(alreadyExistsBullet(undefined, "s", "PENDING")).not.toContain("undefined");
  });
});
