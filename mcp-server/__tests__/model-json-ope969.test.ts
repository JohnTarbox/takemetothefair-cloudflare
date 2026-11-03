/**
 * OPE-969 rework — the shared JSON extractor every string-reply model parser in
 * the MCP Worker now uses (vision booth + presence, read-poster, newsletter
 * itemize). Balanced, string-aware, fence-aware; never repairs.
 */
import { describe, it, expect } from "vitest";
import {
  balancedEnd,
  extractJsonObject,
  extractJsonValue,
  stripCodeFences,
} from "../src/model-json.js";
import { parseVisionReply, parsePresenceReply } from "../src/photo/vision.js";
import { parsePosterReply } from "../src/photo/read-poster.js";
import { parseItemsResponse } from "../src/inbound/newsletter-itemize.js";

const BOOTH = `{"kind":"booth","name":"Radiant Glow","website":null,"products":["tumblers","mugs"],"confidence":1.0,"rationale":"The sign is clearly visible and legible.","identifiable_minor":false}`;

describe("stripCodeFences", () => {
  it("returns the body of a ```json fence, and of a bare ``` fence", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```').trim()).toBe('{"a":1}');
    expect(stripCodeFences('Here:\n```\n{"a":1}\n```\nthanks').trim()).toBe('{"a":1}');
  });
  it("an opening fence the model never closed yields everything after it", () => {
    expect(stripCodeFences('```json\n{"a":1')).toBe('{"a":1');
  });
  it("text with no fence is unchanged", () => {
    expect(stripCodeFences(BOOTH)).toBe(BOOTH);
  });
});

describe("balancedEnd", () => {
  it("ignores braces inside strings and escaped quotes", () => {
    const s = '{"r":"a } and a \\" and {","x":1} tail }';
    expect(s.slice(0, balancedEnd(s, 0))).toBe('{"r":"a } and a \\" and {","x":1}');
  });
  it("-1 for a value that never closes, -2 for a mismatched closer", () => {
    expect(balancedEnd('{"a":[1,2', 0)).toBe(-1);
    expect(balancedEnd('{"a":1]', 0)).toBe(-2);
  });
});

describe("extractJsonValue", () => {
  it("fenced object", () => {
    expect(extractJsonObject("```json\n" + BOOTH + "\n```")).toMatchObject({
      name: "Radiant Glow",
    });
  });

  it("LANDMARK: a brace AFTER the answer — the greedy first-{ to last-} span failed this", () => {
    const reply = "```json\n" + BOOTH + "\n```\nNote: {products} were partly hidden.";
    // What the old code did, kept here so the reason for the change stays visible.
    const greedy = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
    expect(() => JSON.parse(greedy)).toThrow();
    expect(extractJsonObject(reply)).toMatchObject({ kind: "booth", name: "Radiant Glow" });
  });

  it("two objects → the first one", () => {
    expect(extractJsonObject('{"a":1} and also {"b":2}')).toEqual({ a: 1 });
  });

  it("a `}` inside a string value does not end the object", () => {
    expect(
      extractJsonObject('Answer: {"rationale":"banner reads }{ oddly","kind":"signage"} done')
    ).toEqual({ rationale: "banner reads }{ oddly", kind: "signage" });
  });

  it("a fence holding something else does not hide the answer outside it", () => {
    expect(extractJsonObject("```\nnot json here\n```\n" + BOOTH)).toMatchObject({
      name: "Radiant Glow",
    });
  });

  it("still REJECTS non-JSON answers: prose, markdown bullets, truncation", () => {
    expect(extractJsonValue("I cannot tell what this photo shows.")).toEqual({
      ok: false,
      reason: "no-json-span",
      unterminated: false,
    });
    expect(extractJsonValue("* **kind**: booth\n* **name**: Radiant Glow").ok).toBe(false);
    expect(
      extractJsonValue(
        '{"kind":"booth","name":"Aneez Aroma Therapy","products":["essential oils","incen'
      )
    ).toEqual({ ok: false, reason: "no-json-span", unterminated: true });
    expect(extractJsonValue("{ kind: booth }")).toMatchObject({
      ok: false,
      reason: "json-parse-failed",
    });
  });

  it("never returns a NESTED fragment of a broken outer object as the answer", () => {
    expect(extractJsonValue('{"x":{"kind":"booth","name":"Fake"},"y":"cut off').ok).toBe(false);
    expect(extractJsonValue('{bad {"kind":"booth"} still bad}').ok).toBe(false);
  });

  it("array kind: the first balanced array, not first-[ to last-]", () => {
    expect(extractJsonValue('[{"t":"Fair"}] see note [1]', "array")).toMatchObject({
      ok: true,
      value: [{ t: "Fair" }],
    });
  });
});

describe("the parsers that now share it", () => {
  it("vision presence check reads a fenced reply with a trailing brace", () => {
    expect(
      parsePresenceReply('```json\n{"mounted_on":"building_or_wall"}\n```\n(see {note})')
    ).toBe("building_or_wall");
    expect(parsePresenceReply("it is on a wall")).toBeNull();
  });

  it("read-poster reads a fenced reply with a trailing brace, keeps its failure vocabulary", () => {
    const r = parsePosterReply({
      response: '```json\n{"event_name":"Fryeburg Fair","confidence":0.9}\n```\n{end}',
    });
    expect(r).toMatchObject({ event_name: "Fryeburg Fair", failure_reason: null });
    expect(parsePosterReply({ response: "no json" }).failure_reason).toBe("no-json-in-reply");
    expect(parsePosterReply({ response: "{nope}" }).failure_reason).toBe("unparseable-json");
  });

  it("newsletter itemize reads a fenced array with a trailing [1] footnote", () => {
    expect(parseItemsResponse({ response: '```json\n[{"name":"Fair"}]\n```\n[1] source' })).toEqual(
      [{ name: "Fair" }]
    );
  });

  it("vision booth parser: a fenced, noted reply is a clean verdict — no failure, no salvage", () => {
    const id = parseVisionReply({ response: "```json\n" + BOOTH + "\n```\nNote: {x}" });
    expect(id.failureReason).toBeUndefined();
    expect(id.salvaged).toBeUndefined();
    expect(id).toMatchObject({ kind: "booth", businessName: "Radiant Glow", confidence: 1 });
  });
});
