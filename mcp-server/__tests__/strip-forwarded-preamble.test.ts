/**
 * OPE-174 #2 — stripForwardedPreamble removes the Gmail/Apple forwarded-message
 * header block so free-text extraction sees the real event content. Grounded on
 * the Riverfest evidence (inbound_emails f5552b76), which failed extraction with
 * the header block in place.
 */
import { describe, it, expect } from "vitest";
import { stripForwardedPreamble } from "../src/email-handlers/submit.js";

// Real Riverfest body head — note the wrapped Subject line ("more!").
const RIVERFEST = `---------- Forwarded message ---------
From: Piscataqua Riverfest <info@gundalow.org>
Date: Fri, Jul 10, 2026, 14:35
Subject: Saturday 10a-4p: Piscataqua Riverfest! Family fun, boats, music &
more!
To: <john@pimboat.com>


FREE and fun for the family @ Strawbery Banke, Portsmouth
Piscataqua Riverfest
Saturday July 11th, 10a-4p Strawbery Banke, Portsmouth, NH`;

describe("stripForwardedPreamble", () => {
  it("strips the Gmail forwarded header block, keeping the real event content", () => {
    const out = stripForwardedPreamble(RIVERFEST);
    expect(out.startsWith("FREE and fun for the family")).toBe(true);
    // The forwarding metadata is gone — including the wrapped Subject line.
    expect(out).not.toMatch(/Forwarded message/i);
    expect(out).not.toMatch(/^From:/m);
    expect(out).not.toMatch(/^Date:/m);
    expect(out).not.toMatch(/gundalow\.org/);
    // The event details survive.
    expect(out).toContain("Piscataqua Riverfest");
    expect(out).toContain("Saturday July 11th, 10a-4p Strawbery Banke, Portsmouth, NH");
  });

  it("returns the body unchanged when there is no forwarded delimiter", () => {
    const plain = "Hi! We're hosting the Spring Craft Fair on May 3 at Town Hall.";
    expect(stripForwardedPreamble(plain)).toBe(plain);
  });

  it("does NOT strip when the delimiter isn't followed by a header block (conservative)", () => {
    const body = `---------- Forwarded message ---------

Just some prose that isn't a header block at all.`;
    expect(stripForwardedPreamble(body)).toBe(body);
  });

  it("handles the Apple 'Begin forwarded message:' variant", () => {
    const body = `Begin forwarded message:

From: Someone <a@b.com>
Subject: Fair
Date: May 1, 2026
To: me@x.com

The Big Fair is May 10 at the Fairgrounds.`;
    expect(stripForwardedPreamble(body)).toBe("The Big Fair is May 10 at the Fairgrounds.");
  });

  it("resolves nested forwards to the innermost (last) message", () => {
    const body = `---------- Forwarded message ---------
From: Outer <o@x.com>
Subject: Fwd

---------- Forwarded message ---------
From: Inner <i@x.com>
Subject: The Real Event

Craft Fair, June 1, Village Green.`;
    expect(stripForwardedPreamble(body)).toBe("Craft Fair, June 1, Village Green.");
  });

  it("falls back to the original if stripping would consume everything", () => {
    const body = `---------- Forwarded message ---------
From: a@b.com
Date: today`;
    // No blank line / content after headers → don't return empty.
    expect(stripForwardedPreamble(body)).toBe(body);
  });
});
