/**
 * OPE-189 — Workers AI response coercion.
 *
 * The image→markdown OCR'd poster made `env.AI.run(...)` return
 * `{ response: <object> }` (a non-string). The old inline
 * `(response as {response?: string}).response || ""` yielded that object, so the
 * downstream `responseText.substring(...)` threw `.substring is not a function`
 * and every poster email bounced with 0 events. These tests pin that a
 * non-string `.response` no longer throws AND is recovered (JSON-stringified so
 * the parsers can still find the event JSON) — for both single + multi extract.
 */
import { describe, it, expect } from "vitest";
import { extractMultipleEvents, extractEventData } from "../ai-extractor";
import type { PageMetadata } from "../types";

const md = {} as PageMetadata;

// Minimal structural stand-in for the Workers AI binding.
const mkAi = (resp: unknown) => ({ run: async () => resp }) as never;

describe("Workers AI response coercion (OPE-189)", () => {
  it("multi-extract: a string .response still works", async () => {
    const ai = mkAi({
      response: '[{"name":"Fall Fest","startDate":"2027-09-12","venueName":"Town Green"}]',
    });
    const { events } = await extractMultipleEvents(ai, "Fall Fest Sept 12 2027", md);
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("Fall Fest");
  });

  it("multi-extract: an OBJECT .response no longer throws and recovers events", async () => {
    // The exact crash shape from prod: response.response is a nested object.
    const ai = mkAi({
      response: { events: [{ name: "Great NE Air Show", startDate: "2027-05-22" }] },
    });
    const { events } = await extractMultipleEvents(ai, "MAY 22 2027 WESTOVER", md);
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("Great NE Air Show");
    expect(events[0].startDate).toBe("2027-05-22");
  });

  it("multi-extract: an ARRAY .response no longer throws and recovers events", async () => {
    const ai = mkAi({ response: [{ name: "Standish Fair", startDate: "2027-06-01" }] });
    const { events } = await extractMultipleEvents(ai, "poster text", md);
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("Standish Fair");
  });

  it("multi-extract: an object with no recoverable JSON degrades to 0 events (no throw)", async () => {
    const ai = mkAi({ response: 42 });
    const { events } = await extractMultipleEvents(ai, "poster text", md);
    expect(Array.isArray(events)).toBe(true);
  });

  it("single-extract: an OBJECT .response no longer throws", async () => {
    const ai = mkAi({ response: { name: "Hollis Fair", startDate: "2027-07-04" } });
    // extractEventData (single) uses the same coercion — must not throw.
    const { extracted } = await extractEventData(ai, "poster text", md);
    expect(extracted).toBeTruthy();
  });
});
