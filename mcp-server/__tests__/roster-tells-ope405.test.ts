/**
 * OPE-405 item 2 — roster suspicion from prose.
 *
 * The regression case is inbound `34b06089`, scored `new_event` @0.90 while
 * carrying three tells at once. The body below is the real one, verbatim from
 * the analyst's transcription, with the distribution list reconstructed to the
 * reported size.
 */
import { describe, it, expect } from "vitest";
import { detectRosterTells, hasRosterSuspicion } from "../src/email-handlers/roster-tells.js";

const BELGRADE_BODY = `---------- Forwarded message ---------
From: Kristin McDowell <recreation@belgrademaine.gov>
To: ${Array.from({ length: 21 }, (_, i) => `exhibitor${i}@example.com`).join(", ")}

I am attaching the list for Saturday's Fair. I will be out of town but Avery
will be there to greet you! Please see attached!

Kristin McDowell, Recreation Director, Town of Belgrade`;

describe("34b06089 — the regression case", () => {
  it("fires all three tells", () => {
    const t = detectRosterTells("Fwd: Artisan Fair", BELGRADE_BODY, "shpandabear10@gmail.com");
    expect(t.attachingAList).toBe(true);
    expect(t.distributionList).toBe(true);
    expect(t.organizerSender).toBe(true);
    expect(hasRosterSuspicion(t)).toBe(true);
  });

  it("finds the organizer inside the forwarded body, not the envelope sender", () => {
    // The forwarding contributor is an ordinary gmail address; the signal is
    // the municipal address quoted in the body. Checking only the envelope
    // sender would miss every forwarded roster, which is most of them.
    const t = detectRosterTells(null, BELGRADE_BODY, "shpandabear10@gmail.com");
    expect(t.organizerSender).toBe(true);
  });

  it("each tell fires on its own — one is enough", () => {
    expect(
      detectRosterTells(null, "I am attaching the list of vendors.", "a@b.com").matched
    ).toEqual(["attaching-a-list"]);

    const many = Array.from({ length: 9 }, (_, i) => `v${i}@example.com`).join(", ");
    expect(detectRosterTells(null, many, "a@b.com").matched).toEqual(["distribution-list:9"]);

    expect(detectRosterTells(null, "hello", "recreation@belgrademaine.gov").matched).toEqual([
      "organizer-sender",
    ]);
  });
});

describe("does not fire on ordinary mail", () => {
  it("a plain event submission with a flyer", () => {
    const t = detectRosterTells(
      "Our fair this summer",
      "Hi, we're running a craft fair on Aug 3rd at the town green. Attached is our flyer.",
      "someone@gmail.com"
    );
    expect(hasRosterSuspicion(t)).toBe(false);
  });

  it("a short forward between two people", () => {
    const t = detectRosterTells(
      "Fwd: fair",
      "From: bob@gmail.com\nTo: sue@gmail.com\n\nThought you'd like this.",
      "sue@gmail.com"
    );
    expect(t.distributionList).toBe(false);
    expect(hasRosterSuspicion(t)).toBe(false);
  });

  it("counts DISTINCT addresses, so a quoted thread does not inflate the count", () => {
    const repeated = Array.from({ length: 20 }, () => "bob@example.com").join(", ");
    const t = detectRosterTells(null, repeated, "sue@gmail.com");
    expect(t.addressCount).toBe(1);
    expect(t.distributionList).toBe(false);
  });

  it("'attached is our flyer' alone is not a roster tell", () => {
    const t = detectRosterTells(null, "Attached is our flyer for the show.", "a@b.com");
    expect(t.attachingAList).toBe(false);
  });
});
