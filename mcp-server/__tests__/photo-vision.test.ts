import { describe, it, expect, vi } from "vitest";
import {
  parseVisionReply,
  disposition,
  identifyBooth,
  UNIDENTIFIED,
  VISION_MODEL,
  AUTO_WRITE_CONFIDENCE,
  type BoothIdentification,
  type VisionAi,
} from "../src/photo/vision.js";

const boothJson = {
  kind: "booth",
  business_name: "Maple Hollow Farm",
  website: "maplehollow.com",
  products: ["maple syrup", "candy"],
  confidence: 0.92,
  rationale: "large banner across the front of the stall",
};

describe("parseVisionReply", () => {
  it("parses a clean booth identification", () => {
    const id = parseVisionReply({ response: JSON.stringify(boothJson) });
    expect(id).toMatchObject({
      kind: "booth",
      businessName: "Maple Hollow Farm",
      website: "maplehollow.com",
      confidence: 0.92,
    });
    expect(id.products).toEqual(["maple syrup", "candy"]);
  });

  // ── The 2026-08-16 production shape ───────────────────────────────────────
  //
  // Workers AI returns an ALREADY-PARSED object for this model. Measured, not
  // assumed: result.response = {"kind":"booth","business_name":"Petal & Pearl",
  // "confidence":1}. The parser accepted only a STRING response, so two real
  // photos were reported as "the model returned nothing usable" while a perfect
  // identification sat in the reply.
  it("accepts an already-parsed OBJECT response (the live prod shape)", () => {
    const id = parseVisionReply({
      response: { kind: "booth", business_name: "Petal & Pearl", confidence: 1 },
      tool_calls: [],
      usage: { total_tokens: 6468 },
    });
    expect(id.kind).toBe("booth");
    expect(id.businessName).toBe("Petal & Pearl");
    expect(id.confidence).toBe(1);
    expect(id.failureReason).toBeUndefined();
  });

  it("applies the same rules to an object response as to a string one", () => {
    // The general → drop-the-name rule is what stops scenery carrying a vendor
    // into a write. It must not depend on which shape the model replied in.
    const id = parseVisionReply({
      response: { kind: "general", business_name: "Petal & Pearl", confidence: 0.9 },
    });
    expect(id.kind).toBe("general");
    expect(id.businessName).toBeNull();
  });

  it("does not treat an ARRAY response as a parsed object", () => {
    // typeof [] === "object"; an array is not this parser's contract.
    expect(parseVisionReply({ response: [1, 2, 3] }).failureReason).toBeTruthy();
  });

  it("names an object carrying none of our fields", () => {
    const out = parseVisionReply({ response: { nested: true } });
    expect(out.failureReason).toContain("unrecognized-object-shape");
    expect(out.failureReason).toContain("nested");
  });

  it("a genuine kind:'unclear' verdict is NOT marked as a failure", () => {
    // The model declining is a real answer. Flagging it would make every honest
    // "I can't tell" look like a parse bug — the noise this ticket removed.
    const out = parseVisionReply({
      response: { kind: "unclear", rationale: "sign is blurry and side-on" },
    });
    expect(out.kind).toBe("unclear");
    expect(out.rationale).toContain("blurry");
    expect(out.failureReason).toBeUndefined();
  });

  it("accepts a bare string response as well as {response}", () => {
    // Workers AI response shape varies by model (OPE-189).
    expect(parseVisionReply(JSON.stringify(boothJson)).businessName).toBe("Maple Hollow Farm");
  });

  it("digs the JSON out of a markdown fence / surrounding prose", () => {
    const wrapped = "Sure!\n```json\n" + JSON.stringify(boothJson) + "\n```\nHope that helps.";
    expect(parseVisionReply({ response: wrapped }).businessName).toBe("Maple Hollow Farm");
  });

  it("strips a vendor name off a 'general' photo so scenery can never carry one", () => {
    const id = parseVisionReply({
      response: JSON.stringify({ ...boothJson, kind: "general" }),
    });
    expect(id.kind).toBe("general");
    expect(id.businessName).toBeNull();
    expect(id.website).toBeNull();
    expect(id.products).toEqual([]);
  });

  it("treats the string 'null'/'none' as absent, not as a name", () => {
    const id = parseVisionReply({
      response: JSON.stringify({ ...boothJson, business_name: "null", website: "none" }),
    });
    expect(id.businessName).toBeNull();
    expect(id.website).toBeNull();
  });

  it("clamps a confidence outside 0..1 and coerces a non-numeric one", () => {
    expect(
      parseVisionReply({ response: JSON.stringify({ ...boothJson, confidence: 5 }) }).confidence
    ).toBe(1);
    expect(
      parseVisionReply({ response: JSON.stringify({ ...boothJson, confidence: -2 }) }).confidence
    ).toBe(0);
    expect(
      parseVisionReply({ response: JSON.stringify({ ...boothJson, confidence: "high" }) })
        .confidence
    ).toBe(0);
  });

  it("maps an unknown kind to 'unclear' rather than trusting it", () => {
    expect(
      parseVisionReply({ response: JSON.stringify({ ...boothJson, kind: "stall" }) }).kind
    ).toBe("unclear");
  });

  // A garbage reply must degrade, never throw — it's inside the inbound workflow.
  //
  // OPE-403 follow-up: these now also carry a `failureReason` naming WHICH path
  // bailed. Asserted with `toMatchObject` against the identification fields
  // rather than `toEqual(UNIDENTIFIED)`, because exact equality would forbid the
  // diagnostic the first live photo proved we needed — the old assertion
  // actively locked in "every failure looks identical".
  const unusable = { kind: "unclear", businessName: null, confidence: 0 };

  it("degrades to unclear for unusable replies, and says why", () => {
    for (const raw of [
      "",
      null,
      { response: "I cannot help with that." },
      { response: "{ not json" },
      // Non-string .response is the exact shape that crashed the entrypoint (OPE-189).
      { response: { nested: true } },
      { response: 42 },
    ]) {
      const out = parseVisionReply(raw);
      expect(out).toMatchObject(unusable);
      expect(out.failureReason).toBeTruthy();
    }
  });

  it("distinguishes prose from malformed JSON from an unreadable shape", () => {
    expect(parseVisionReply({ response: "I cannot help." }).failureReason).toContain(
      "no-json-span"
    );
    // No closing brace → there is no JSON span to even attempt, so this is
    // no-json-span too. Malformed JSON needs BOTH braces present.
    expect(parseVisionReply({ response: "{ not json" }).failureReason).toContain("no-json-span");
    expect(parseVisionReply({ response: '{"kind":"booth",,,}' }).failureReason).toContain(
      "json-parse-failed"
    );
    expect(parseVisionReply({ response: 42 }).failureReason).toContain("empty-text");
  });

  // Pinned: the shared constant itself must stay clean, so a successful parse
  // spreading from it never inherits a stale reason.
  it("the UNIDENTIFIED constant carries no failureReason", () => {
    expect(UNIDENTIFIED.failureReason).toBeUndefined();
  });
});

describe("identifyBooth", () => {
  it("calls the vision model with a byte array and the prompt", async () => {
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify(boothJson) });
    const ai: VisionAi = { run };
    const id = await identifyBooth(ai, new Uint8Array([1, 2, 3]));
    expect(id.businessName).toBe("Maple Hollow Farm");
    expect(run).toHaveBeenCalledOnce();
    const [model, input] = run.mock.calls[0];
    expect(model).toBe(VISION_MODEL);
    // The binding wants a plain array, not a Uint8Array.
    expect(Array.isArray(input.image)).toBe(true);
    expect(input.image).toEqual([1, 2, 3]);
    expect(input.prompt).toContain("business_name");
  });

  it("names the thrown error rather than swallowing it (OPE-403 follow-up)", async () => {
    // A binding that rejects — model not enabled, unsupported input, quota — is
    // a different problem from a reply we failed to parse, and both used to
    // arrive as the same "returned nothing usable".
    const ai: VisionAi = { run: vi.fn().mockRejectedValue(new Error("5007 unsupported input")) };
    const out = await identifyBooth(ai, new Uint8Array([1]));
    expect(out.kind).toBe("unclear");
    expect(out.failureReason).toContain("ai-run-threw");
    expect(out.failureReason).toContain("5007 unsupported input");
  });

  it("degrades instead of throwing when the model fails (never sinks the batch)", async () => {
    // The load-bearing property: identifyBooth resolves, so one bad frame
    // cannot take down the inbound-email workflow for the whole batch.
    const ai: VisionAi = { run: vi.fn().mockRejectedValue(new Error("model unavailable")) };
    const out = await identifyBooth(ai, new Uint8Array([1]));
    expect(out).toMatchObject({ kind: "unclear", businessName: null, confidence: 0 });
  });
});

describe("disposition", () => {
  const id = (over: Partial<BoothIdentification> = {}): BoothIdentification => ({
    kind: "booth",
    businessName: "Maple Hollow Farm",
    website: null,
    products: [],
    confidence: 0.9,
    rationale: "",
    ...over,
  });

  it("writes a confident, named booth", () => {
    expect(disposition(id()).action).toBe("write");
  });

  it("skips general scenery (OPE-205's job, not a vendor write)", () => {
    const d = disposition(id({ kind: "general", businessName: null }));
    expect(d.action).toBe("skip");
  });

  it("stages an unclear photo", () => {
    expect(disposition(id({ kind: "unclear" })).action).toBe("stage");
  });

  it("stages a booth with no legible name", () => {
    const d = disposition(id({ businessName: null }));
    expect(d.action).toBe("stage");
    if (d.action !== "stage") return;
    expect(d.reason).toContain("no legible business name");
  });

  it("stages rather than writes when confidence is below threshold", () => {
    const d = disposition(id({ confidence: AUTO_WRITE_CONFIDENCE - 0.01 }));
    expect(d.action).toBe("stage");
    if (d.action !== "stage") return;
    expect(d.reason).toContain("below");
  });

  it("writes exactly at the threshold", () => {
    expect(disposition(id({ confidence: AUTO_WRITE_CONFIDENCE })).action).toBe("write");
  });
});
