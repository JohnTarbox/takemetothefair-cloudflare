/**
 * OPE-1339 — a vision reply that names the booth but is not valid JSON must not
 * be recorded as "could not tell what the photo shows" — and must never write.
 *
 * Fixtures are the replies stored in prod `admin_actions.payload_json.failure_reason`
 * for proposals d86c3837 (Radiant Glow) and c146f4e5 (Aneez Aroma Therapy),
 * 2026-10-10, quoted as stored.
 */
import { describe, it, expect, vi } from "vitest";
import {
  disposition,
  identifyBooth,
  parseVisionReply,
  salvageReply,
  VISION_RESPONSE_FORMAT,
  type VisionAi,
} from "../src/photo/vision.js";

const RADIANT_RETRY = `**Reported Data:**

* **kind**: booth
* **name**: Radiant Glow
* **confidence**: 1.0
* **rationale**: The sign is clearly visible and legible.
* **identifiable_minor**: false

**Note:** There are no products listed as they are not visible i`;

const RADIANT_FIRST = `**Booth Details**

* Kind: booth
* Name: Radiant Glow
* Website: null
* Products: ["tumblers", "mugs", "coasters"]
* Confidence: 0.9
* Rationale: The sign is clearly visible and well`;

const ANEEZ_FIRST_TRUNCATED = `{"kind":"booth","name":"Aneez Aroma Therapy","products":["essential oils","aromatherapy sprays","diffusers","perfumes","colognes","body lotions","soaps","candles","potpourri","incen`;

const ANEEZ_RETRY = `The image depicts a booth at an agricultural fair or craft show, showcasing various products and services.

*   **Kind**: booth
*   **Name**: Aneez Aroma Therapy
*   **Website**: None
*   **Products**:
    *   Essential oils
    *   Perfum`;

/** OPE-1337's 11:11 shot, replayed 2026-10-11: prose that MENTIONS names but answers nothing. */
const SENIOR_EXPO_PROSE = `The image shows a convention center with several tables set up for various organizations, including "kind" and "The Park Danforth". The tables are arranged in rows, with some having signs.`;

describe("salvageReply (OPE-1339)", () => {
  it("reads the markdown bullet answer — Radiant Glow at 1.0", () => {
    const s = salvageReply(RADIANT_RETRY);
    expect(s).toMatchObject({
      kind: "booth",
      businessName: "Radiant Glow",
      confidence: 1,
      identifiableMinor: false,
      salvaged: "markdown",
    });
  });

  it("reads plain `Key: value` lines and null-words", () => {
    expect(salvageReply(RADIANT_FIRST)).toMatchObject({
      businessName: "Radiant Glow",
      confidence: 0.9,
      website: null,
      salvaged: "markdown",
    });
  });

  it("reads the complete pairs out of JSON that was cut off mid-products", () => {
    expect(salvageReply(ANEEZ_FIRST_TRUNCATED)).toMatchObject({
      kind: "booth",
      businessName: "Aneez Aroma Therapy",
      salvaged: "truncated-json",
    });
  });

  it("salvages NOTHING from prose that merely mentions names — no answer, no read", () => {
    expect(salvageReply(SENIOR_EXPO_PROSE)).toBeNull();
    expect(salvageReply("I cannot determine what this image shows.")).toBeNull();
  });
});

describe("parseVisionReply carries the salvage but keeps the failure (OPE-1339)", () => {
  it("still reports the parse failure, now beside what it read", () => {
    const r = parseVisionReply({ response: RADIANT_RETRY });
    expect(r.failureReason).toMatch(/^no-json-span/);
    expect(r).toMatchObject({ businessName: "Radiant Glow", salvaged: "markdown" });
  });
});

describe("disposition: a salvaged read is ALWAYS staged (OPE-1339)", () => {
  it("stages a confidence-1.0, no-minor booth that would otherwise auto-write", () => {
    const id = salvageReply(RADIANT_RETRY)!;
    expect(id.confidence).toBe(1);
    expect(id.identifiableMinor).toBe(false); // landmark: every write condition is met
    const d = disposition(id);
    expect(d).toMatchObject({ action: "stage", stageKind: "parse_salvaged" });
    expect(d.action === "stage" && d.reason).toContain('"Radiant Glow"');
  });

  it("stages salvaged scenery and performers too — no gallery attach, no lineup link", () => {
    expect(disposition(salvageReply("* Kind: scenery\n* Confidence: 0.9")!).action).toBe("stage");
    expect(
      disposition(salvageReply("* Kind: performer\n* Name: Axe Women\n* Confidence: 1.0")!).action
    ).toBe("stage");
  });
});

describe("identifyBooth prefers a clean retry, then a named salvage (OPE-1339)", () => {
  const ai = (...replies: unknown[]): VisionAi => {
    const run = vi.fn();
    for (const r of replies) run.mockResolvedValueOnce(r);
    return { run };
  };

  it("Aneez: truncated JSON then markdown → staged salvage naming the booth, with both reasons", async () => {
    const id = await identifyBooth(
      ai({ response: ANEEZ_FIRST_TRUNCATED }, { response: ANEEZ_RETRY }),
      new Uint8Array([1])
    );
    expect(id).toMatchObject({ kind: "booth", businessName: "Aneez Aroma Therapy" });
    expect(id.salvaged).toBeDefined();
    expect(id.failureReason).toMatch(/retried once/);
    expect(disposition(id)).toMatchObject({ action: "stage", stageKind: "parse_salvaged" });
  });

  it("a clean JSON retry wins over a salvageable first try", async () => {
    const id = await identifyBooth(
      ai(
        { response: RADIANT_RETRY },
        {
          response: {
            kind: "booth",
            name: "Radiant Glow",
            website: null,
            products: [],
            confidence: 1,
            rationale: "clear sign",
            identifiable_minor: false,
          },
        }
      ),
      new Uint8Array([1])
    );
    expect(id.salvaged).toBeUndefined();
    expect(id.failureReason).toBeUndefined();
  });

  it("two unsalvageable replies are still UNIDENTIFIED (unchanged)", async () => {
    const id = await identifyBooth(
      ai({ response: SENIOR_EXPO_PROSE }, { response: SENIOR_EXPO_PROSE }),
      new Uint8Array([1])
    );
    expect(id).toMatchObject({ kind: "unclear", businessName: null, confidence: 0 });
    expect(id.salvaged).toBeUndefined();
  });
});

describe("output budget (OPE-1339)", () => {
  it("caps products in the schema and asks for more tokens than the truncated reply used", async () => {
    expect(VISION_RESPONSE_FORMAT.json_schema.properties.products).toMatchObject({ maxItems: 8 });
    const run = vi.fn().mockResolvedValue({ response: { kind: "unclear" } });
    await identifyBooth({ run }, new Uint8Array([1]));
    expect(run.mock.calls[0][1].max_tokens).toBeGreaterThanOrEqual(768);
  });
});
