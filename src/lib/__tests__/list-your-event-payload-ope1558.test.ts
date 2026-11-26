/**
 * OPE-1558 — the no-login /list-your-event form's contract with
 * /api/suggest-event/submit.
 *
 * The payload is checked against the ROUTE'S OWN zod schema rather than a
 * restatement of it: a form whose body the route rejects is a 400 on every
 * submit, and a hand-copied expectation would keep passing while that happened.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { submitEventSchema } from "@/app/api/suggest-event/submit/schema";
import {
  EMPTY_LIST_YOUR_EVENT_INPUT,
  buildListYourEventPayload,
  normalizeWebsite,
  validateListYourEvent,
  type ListYourEventInput,
} from "@/lib/list-your-event/payload";

const TODAY = "2026-11-01";

const filled: ListYourEventInput = {
  ...EMPTY_LIST_YOUR_EVENT_INPUT,
  name: "  Hollis PTG Holiday Craft Fair ",
  startDate: "2026-12-05",
  town: "Hollis",
  state: "ME",
  email: "organizer@example.org",
};

describe("validateListYourEvent", () => {
  it("accepts the minimum: name, first day, town, state, email", () => {
    expect(validateListYourEvent(filled, TODAY)).toEqual({});
  });

  it("an empty form names every required field — and only those", () => {
    const errors = validateListYourEvent(EMPTY_LIST_YOUR_EVENT_INPUT, TODAY);
    expect(Object.keys(errors).sort()).toEqual(["email", "name", "startDate", "state", "town"]);
  });

  it("today is listable; yesterday is not (calendar strings, not instants)", () => {
    expect(validateListYourEvent({ ...filled, startDate: TODAY }, TODAY).startDate).toBeUndefined();
    expect(validateListYourEvent({ ...filled, startDate: "2026-10-31" }, TODAY).startDate).toMatch(
      /passed/
    );
  });

  it("rejects an impossible date rather than letting Date roll it over", () => {
    expect(validateListYourEvent({ ...filled, startDate: "2026-02-30" }, TODAY).startDate).toBe(
      "That date doesn't look right."
    );
  });

  it("an end day before the first day is refused; equal is fine", () => {
    expect(validateListYourEvent({ ...filled, endDate: "2026-12-04" }, TODAY).endDate).toMatch(
      /before/
    );
    expect(
      validateListYourEvent({ ...filled, endDate: "2026-12-05" }, TODAY).endDate
    ).toBeUndefined();
  });

  it("a state outside the six the site covers is refused", () => {
    expect(validateListYourEvent({ ...filled, state: "NY" }, TODAY).state).toBeDefined();
  });

  it("a website is optional, but a typed one must be a real address", () => {
    expect(validateListYourEvent({ ...filled, website: "" }, TODAY).website).toBeUndefined();
    expect(validateListYourEvent({ ...filled, website: "myfair" }, TODAY).website).toBeDefined();
    expect(
      validateListYourEvent({ ...filled, website: "facebook.com/events/123" }, TODAY).website
    ).toBeUndefined();
  });
});

describe("normalizeWebsite", () => {
  it("adds a scheme to a bare host and keeps an explicit one", () => {
    expect(normalizeWebsite("example.com")).toBe("https://example.com/");
    expect(normalizeWebsite("http://example.com/fair")).toBe("http://example.com/fair");
  });
  it("refuses a non-web scheme", () => {
    expect(normalizeWebsite("javascript:alert(1)")).toBeNull();
  });
});

describe("buildListYourEventPayload", () => {
  it("is accepted by the submit route's own schema", () => {
    const parsed = submitEventSchema.safeParse({
      ...buildListYourEventPayload({
        ...filled,
        venueName: "Hollis Elementary",
        category: "Craft Fair",
        website: "hollisptg.org",
      }),
      turnstileToken: "t",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("a single-day event sends endDate = startDate, trimmed fields, no empty optionals", () => {
    const p = buildListYourEventPayload(filled);
    expect(p).toEqual({
      name: "Hollis PTG Holiday Craft Fair",
      startDate: "2026-12-05",
      endDate: "2026-12-05",
      venueName: null,
      venueCity: "Hollis",
      venueState: "ME",
      suggesterEmail: "organizer@example.org",
      source: "community",
      intakeForm: "list-your-event",
    });
  });

  it("the route schema still refuses an unknown intakeForm (the tag is not free text)", () => {
    const parsed = submitEventSchema.safeParse({
      ...buildListYourEventPayload(filled),
      intakeForm: "anything",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("submit route wiring (source shape)", () => {
  const route = readFileSync("src/app/api/suggest-event/submit/route.ts", "utf8");

  it("tags list-your-event rows, for community, non-internal callers only", () => {
    const at = route.indexOf('tagList.push("list-your-event")');
    expect(at, "the tag push is missing").toBeGreaterThan(0);
    const guard = route.slice(route.lastIndexOf("if (", at), at);
    expect(guard).toContain('data.intakeForm === "list-your-event"');
    expect(guard).toContain("!isInternal");
    // and the tag list it pushes into is the one inserted
    expect(route.indexOf("tags: JSON.stringify(tagList)")).toBeGreaterThan(at);
  });

  it("reports receiptSent from the ack outcome itself", () => {
    expect(route).toContain('receiptSent: ackOutcome === "sent"');
  });
});
