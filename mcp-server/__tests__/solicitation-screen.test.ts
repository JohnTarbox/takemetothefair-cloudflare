/**
 * OPE-278 — list-broker / attendee-list solicitation screen.
 *
 * Unit tests for the deterministic detector, plus an integration test proving
 * classifyIntent overrides the AI's `new_event` to `spam` for the exact
 * production body that created the duplicate `craftfest-cotuit-2026-2`
 * (inbound_emails c3198c13). The override is what makes the entrypoint silently
 * quarantine the message before any event is created.
 */
import { describe, expect, it, vi } from "vitest";
import { isListBrokerSolicitation } from "../src/email-handlers/solicitation-screen.js";
import { classifyIntent, type AiBinding, type ClassifierInput } from "../src/intent-classifier.js";

// Verbatim body of the production solicitation (inbound_emails c3198c13).
const CRAFTFEST_SPAM_BODY = `Hi,

How are you?

*CraftFest Cotuit 2026*, a pre-registered *4,588 *Attendee list is
available! to fulfil your promotional efforts.
*Date*: 15 - 16 Aug 2026

*Venue*: Barnstable, USA

Could you let me know if you want to receive the *Attendee List* with
the *Exclusive fee*?

*List Includes: -*

Contact information

email address

company Title

URL/website

mobile number

title/designation.

Kindly describes your response:

· *Yes, I am Interested*, send me *Exclusive Fee* and More information

· *OPT-OUT*

Best Regards,

Sara Beth`;

describe("isListBrokerSolicitation", () => {
  it("flags the production CraftFest attendee-list solicitation", () => {
    expect(
      isListBrokerSolicitation(
        "Complete Attendee Information for CraftFest Cotuit 2026",
        CRAFTFEST_SPAM_BODY
      )
    ).toBe(true);
  });

  it("flags on list-signal + commercial ask alone", () => {
    expect(
      isListBrokerSolicitation(
        "Data available",
        "We have a pre-registered attendee list available for a small fee."
      )
    ).toBe(true);
  });

  it("flags on two independent list signals", () => {
    expect(
      isListBrokerSolicitation(
        "",
        "Our mailing list is available; the list includes verified buyers."
      )
    ).toBe(true);
  });

  it("does NOT flag a genuine event submission", () => {
    expect(
      isListBrokerSolicitation(
        "Please add our craft fair",
        "Hi! We're hosting the Topsfield Strawberry Festival on June 13 2026 at the Town Common. Vendors welcome — details at https://example.com. Thanks!"
      )
    ).toBe(false);
  });

  it("does NOT flag on a lone incidental phrase (e.g. a contact-info footer)", () => {
    expect(
      isListBrokerSolicitation(
        "Question about vending",
        "Can I get a booth? My email address is jane@example.com and my phone number is 555-1234."
      )
    ).toBe(false);
  });

  it("does NOT flag a bare 'mailing list' mention without corroboration", () => {
    expect(
      isListBrokerSolicitation(
        "Newsletter",
        "Please add me to your mailing list for event updates."
      )
    ).toBe(false);
  });
});

function mockAi(responseText: string): AiBinding {
  return { run: vi.fn().mockResolvedValue({ response: responseText }) };
}

const BASE_INPUT: ClassifierInput = {
  toAddress: "submit@meetmeatthefair.com",
  fromAddress: "sara.beth.sovrago@gmail.com",
  senderTrustTier: "unknown",
  isReplyToOurThread: false,
  attachmentCount: 0,
  attachmentTypes: [],
  subject: "Complete Attendee Information for CraftFest Cotuit 2026",
  bodyText: CRAFTFEST_SPAM_BODY,
};

describe("classifyIntent — solicitation override (OPE-278)", () => {
  it("overrides the AI's new_event to spam at quarantine-grade confidence", async () => {
    // The AI mislabels it as new_event (as it did in production).
    const ai = mockAi(
      JSON.stringify({
        intent: "new_event",
        sub_intent: "free_text",
        confidence: 0.9,
        rationale: "names an event",
      })
    );
    const result = await classifyIntent(ai, BASE_INPUT);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].intent).toBe("spam");
    expect(result.intents[0].confidence).toBeGreaterThanOrEqual(0.9); // ≥ SPAM_QUARANTINE_THRESHOLD
    expect(result.intents[0].rationale).toContain("solicitation-screen");
    expect(result.fromAi).toBe(true); // AI ran → entrypoint's fromAi-gated quarantine fires
  });

  it("leaves a genuine event submission classified as new_event", async () => {
    const ai = mockAi(
      JSON.stringify({
        intent: "new_event",
        sub_intent: "single_url",
        confidence: 0.95,
        rationale: "event URL",
      })
    );
    const result = await classifyIntent(ai, {
      ...BASE_INPUT,
      subject: "Please list our fair",
      bodyText:
        "We're hosting the Topsfield Strawberry Festival on June 13 2026. Details at https://example.com/",
    });
    expect(result.intents[0].intent).toBe("new_event");
  });
});
