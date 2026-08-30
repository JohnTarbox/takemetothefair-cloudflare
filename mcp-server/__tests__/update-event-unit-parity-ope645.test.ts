/**
 * OPE-645 — `previousValues` and `newValues` must be in the same unit.
 *
 * `previousValues` reads the stored column; `newValues` used to echo the raw
 * argument. For any field with a `transform` those differ, and the response
 * carried both under the SAME key:
 *
 *     previousValues: { ticket_price_min: 1300 }   // cents
 *     newValues:      { ticket_price_min: 13   }   // dollars
 *
 * Nothing had changed. `update_event`'s own response says field-level edits
 * leave no audit trail (OPE-505), so a confirmation whose before/after are in
 * different units is the only record of the edit.
 */
import { describe, it, expect } from "vitest";
import { reportedNewValue } from "../src/helpers.js";
import { dollarsToCents } from "../src/helpers.js";

/** The real mapping shape from admin.ts's fieldMap. */
const TICKET_MIN = { param: "ticket_price_min", column: "ticketPriceMinCents" };
const DESCRIPTION = { param: "description", column: "description" };

describe("money fields report the STORED unit on both sides", () => {
  it("reports cents, matching previousValues — the Lancaster Fair case", () => {
    // update_event(ticket_price_min: 13) against a row already storing 1300.
    const params = { ticket_price_min: 13 };
    const updates = { ticketPriceMinCents: dollarsToCents(13) };
    const previousValue = 1300; // what previousValues reads off the column

    const reported = reportedNewValue("ticket_price_min", TICKET_MIN, updates, params);

    expect(reported).toBe(1300);
    // The acceptance: a no-op re-write reports no change.
    expect(reported).toBe(previousValue);
    // And specifically NOT the dollars argument, which is what it used to be.
    expect(reported).not.toBe(13);
  });

  it("still reports a REAL change as a change", () => {
    // Parity must not be achieved by reporting the old value for everything.
    const reported = reportedNewValue(
      "ticket_price_min",
      TICKET_MIN,
      { ticketPriceMinCents: dollarsToCents(20) },
      { ticket_price_min: 20 }
    );
    expect(reported).toBe(2000);
    expect(reported).not.toBe(1300);
  });

  it("covers vendor fees, which share the dollars-in/cents-stored shape", () => {
    const reported = reportedNewValue(
      "vendor_fee_min",
      { param: "vendor_fee_min", column: "vendorFeeMinCents" },
      { vendorFeeMinCents: dollarsToCents(45) },
      { vendor_fee_min: 45 }
    );
    expect(reported).toBe(4500);
  });
});

describe("the fix is structural, so it covers every transformed field", () => {
  it("reports the NORMALIZED application_deadline, not the raw string", () => {
    // Same divergence, different transform — the ticket found it on money, but
    // money was not special. `previousValues` would show a Date off the column
    // while `newValues` showed "2026-09-12".
    const normalized = new Date("2026-09-12T12:00:00.000Z");
    const reported = reportedNewValue(
      "application_deadline",
      { param: "application_deadline", column: "applicationDeadline" },
      { applicationDeadline: normalized },
      { application_deadline: "2026-09-12" }
    );
    expect(reported).toBe(normalized);
    expect(reported).not.toBe("2026-09-12");
  });

  it("passes untransformed fields straight through", () => {
    const reported = reportedNewValue(
      "description",
      DESCRIPTION,
      { description: "New text" },
      { description: "New text" }
    );
    expect(reported).toBe("New text");
  });
});

describe("fields with no mapping fall back to the argument", () => {
  it("handles name/slug, which the caller special-cases", () => {
    // fieldMap has no entry for these; the argument IS the stored form.
    expect(reportedNewValue("name", undefined, {}, { name: "Lancaster Fair" })).toBe(
      "Lancaster Fair"
    );
  });

  it("falls back when the column was not part of this update", () => {
    // A requested field that never reached `updates` (e.g. gated out) must not
    // report `undefined` as though it had been written.
    expect(
      reportedNewValue(
        "ticket_url",
        { param: "ticket_url", column: "ticketUrl" },
        {},
        {
          ticket_url: "https://example.com",
        }
      )
    ).toBe("https://example.com");
  });
});
