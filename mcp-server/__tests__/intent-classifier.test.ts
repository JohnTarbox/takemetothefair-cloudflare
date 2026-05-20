/**
 * Tests for the intent classifier — pure-function tests for the JSON
 * parser, plus a small set of mocked-AI integration tests that pin the
 * 12 single-intent + 4 multi-intent test cases from the spec.
 *
 * No real Workers AI calls; AiBinding is mocked.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyIntent,
  parseClassifierResponse,
  CLASSIFIER_VERSION,
  type AiBinding,
  type ClassifierInput,
} from "../src/intent-classifier.js";

const SAMPLE_INPUT: ClassifierInput = {
  toAddress: "submit@meetmeatthefair.com",
  fromAddress: "alice@example.com",
  senderTrustTier: "unknown",
  isReplyToOurThread: false,
  attachmentCount: 0,
  attachmentTypes: [],
  subject: "Test event",
  bodyText: "Check out my event!",
};

function mockAi(responseText: string): AiBinding {
  return {
    run: vi.fn().mockResolvedValue({ response: responseText }),
  };
}

function mockAiTimeout(): AiBinding {
  return {
    run: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
  };
}

describe("parseClassifierResponse — happy path", () => {
  it("parses a clean single-intent JSON object", () => {
    const out = parseClassifierResponse(
      JSON.stringify({
        intent: "new_event",
        sub_intent: "single_url",
        confidence: 0.94,
        rationale: "URL to event page",
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].intent).toBe("new_event");
    expect(out[0].subIntent).toBe("single_url");
    expect(out[0].confidence).toBeCloseTo(0.94);
  });

  it("parses a multi-intent JSON array under .intents", () => {
    const out = parseClassifierResponse(
      JSON.stringify({
        intents: [
          {
            intent: "source_suggestion",
            ref_url: "https://example.com/",
            confidence: 0.92,
            rationale: "source URL",
          },
          {
            intent: "new_event",
            sub_intent: "single_url",
            ref_url: "https://fb.com/event",
            confidence: 0.88,
            rationale: "event URL",
          },
        ],
      })
    );
    expect(out).toHaveLength(2);
    expect(out[0].intent).toBe("source_suggestion");
    expect(out[1].intent).toBe("new_event");
    expect(out[1].refUrl).toBe("https://fb.com/event");
  });

  it("caps multi-intent at 4 children (spec §C.5)", () => {
    const intents = Array.from({ length: 7 }, (_, i) => ({
      intent: "new_event",
      sub_intent: "single_url",
      confidence: 0.9 - i * 0.01,
      rationale: `event ${i}`,
    }));
    const out = parseClassifierResponse(JSON.stringify({ intents }));
    expect(out).toHaveLength(4);
  });
});

describe("parseClassifierResponse — robustness", () => {
  it("strips ```json fences", () => {
    const out = parseClassifierResponse(
      '```json\n{"intent":"spam","confidence":0.95,"rationale":"pharma keywords"}\n```'
    );
    expect(out[0].intent).toBe("spam");
  });

  it("tolerates trailing prose after the JSON object", () => {
    const out = parseClassifierResponse(
      '{"intent":"correction","confidence":0.9,"rationale":"wrong date"} — that\'s my best guess.'
    );
    expect(out[0].intent).toBe("correction");
  });

  it("falls back to unclear when the JSON is malformed", () => {
    const out = parseClassifierResponse("not-json at all");
    expect(out).toHaveLength(1);
    expect(out[0].intent).toBe("unclear");
    expect(out[0].confidence).toBe(0);
  });

  it("falls back to unclear when intent is not in the taxonomy", () => {
    const out = parseClassifierResponse(
      JSON.stringify({ intent: "made_up_intent", confidence: 0.9, rationale: "" })
    );
    expect(out[0].intent).toBe("unclear");
  });

  it("clamps confidence above 1.0 to 1.0", () => {
    const out = parseClassifierResponse(
      JSON.stringify({ intent: "support", confidence: 1.5, rationale: "" })
    );
    expect(out[0].confidence).toBe(1);
  });

  it("clamps negative confidence to 0", () => {
    const out = parseClassifierResponse(
      JSON.stringify({ intent: "support", confidence: -0.2, rationale: "" })
    );
    expect(out[0].confidence).toBe(0);
  });

  it("accepts confidence as a string", () => {
    const out = parseClassifierResponse(
      JSON.stringify({ intent: "support", confidence: "0.77", rationale: "" })
    );
    expect(out[0].confidence).toBeCloseTo(0.77);
  });
});

describe("classifyIntent — fail-safe integration", () => {
  it("returns the parsed response when AI succeeds", async () => {
    const ai = mockAi(
      JSON.stringify({
        intent: "new_event",
        sub_intent: "single_url",
        confidence: 0.91,
        rationale: "single URL to event",
      })
    );
    const result = await classifyIntent(ai, SAMPLE_INPUT);
    expect(result.fromAi).toBe(true);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].intent).toBe("new_event");
    expect(result.version).toBe(CLASSIFIER_VERSION);
  });

  it("returns unclear fallback on AI throw", async () => {
    const ai: AiBinding = { run: vi.fn().mockRejectedValue(new Error("AI down")) };
    const result = await classifyIntent(ai, SAMPLE_INPUT);
    expect(result.fromAi).toBe(false);
    expect(result.intents[0].intent).toBe("unclear");
    expect(result.intents[0].confidence).toBe(0);
    expect(result.intents[0].rationale).toContain("classifier-error");
  });

  it("returns unclear fallback on AI timeout", async () => {
    const ai = mockAiTimeout();
    const result = await classifyIntent(ai, SAMPLE_INPUT);
    expect(result.fromAi).toBe(false);
    expect(result.intents[0].intent).toBe("unclear");
    expect(result.intents[0].rationale).toContain("timeout");
  }, 5000);

  it("returns unclear fallback when AI returns non-JSON garbage", async () => {
    const ai = mockAi("Yeah, I think it's probably spam.");
    const result = await classifyIntent(ai, SAMPLE_INPUT);
    expect(result.fromAi).toBe(true);
    expect(result.intents[0].intent).toBe("unclear");
  });
});

// Spec §"Canonical test cases" — 12 single-intent + 4 multi-intent.
// These are integration-style: we feed the parser the JSON shape the
// LLM is expected to produce for each canonical case. The actual LLM
// behavior is validated separately via live test submissions.
describe("Spec canonical cases — parser fidelity for expected outputs", () => {
  const cases: {
    name: string;
    json: object;
    assert: (out: ReturnType<typeof parseClassifierResponse>) => void;
  }[] = [
    {
      name: "Case 1: single URL to event page → new_event/single_url",
      json: { intent: "new_event", sub_intent: "single_url", confidence: 0.94, rationale: "..." },
      assert: (o) => {
        expect(o[0].intent).toBe("new_event");
        expect(o[0].subIntent).toBe("single_url");
      },
    },
    {
      name: "Case 2: 3 URLs → new_event/multi_url",
      json: { intent: "new_event", sub_intent: "multi_url", confidence: 0.89, rationale: "..." },
      assert: (o) => {
        expect(o[0].subIntent).toBe("multi_url");
      },
    },
    {
      name: "Case 3: prose-only event → new_event/free_text",
      json: { intent: "new_event", sub_intent: "free_text", confidence: 0.88, rationale: "..." },
      assert: (o) => {
        expect(o[0].subIntent).toBe("free_text");
      },
    },
    {
      name: "Case 4: PDF only → new_event/attachment_only",
      json: {
        intent: "new_event",
        sub_intent: "attachment_only",
        confidence: 0.86,
        rationale: "...",
      },
      assert: (o) => {
        expect(o[0].subIntent).toBe("attachment_only");
      },
    },
    {
      name: "Case 5: classifier_override — body says correction, sent to submit@",
      json: { intent: "correction", confidence: 0.91, rationale: "the date is wrong" },
      assert: (o) => {
        expect(o[0].intent).toBe("correction");
      },
    },
    {
      name: "Case 6: vendor_inquiry",
      json: { intent: "vendor_inquiry", confidence: 0.78, rationale: "asks about booth" },
      assert: (o) => {
        expect(o[0].intent).toBe("vendor_inquiry");
      },
    },
    {
      name: "Case 7: press inquiry",
      json: { intent: "press", confidence: 0.82, rationale: "Boston Globe" },
      assert: (o) => {
        expect(o[0].intent).toBe("press");
      },
    },
    {
      name: "Case 8: claim_request",
      json: { intent: "claim_request", confidence: 0.81, rationale: "I am the organizer" },
      assert: (o) => {
        expect(o[0].intent).toBe("claim_request");
      },
    },
    {
      name: "Case 9: unsubscribe",
      json: { intent: "unsubscribe", confidence: 0.97, rationale: "stop emailing me" },
      assert: (o) => {
        expect(o[0].intent).toBe("unsubscribe");
        expect(o[0].confidence).toBeGreaterThanOrEqual(0.95);
      },
    },
    {
      name: "Case 10: obvious spam",
      json: { intent: "spam", confidence: 0.95, rationale: "pharma keywords" },
      assert: (o) => {
        expect(o[0].intent).toBe("spam");
        expect(o[0].confidence).toBeGreaterThanOrEqual(0.9);
      },
    },
    {
      name: "Case 11: just saying thanks → unclear, low confidence",
      json: { intent: "unclear", confidence: 0.4, rationale: "just a thank-you" },
      assert: (o) => {
        expect(o[0].intent).toBe("unclear");
        expect(o[0].confidence).toBeLessThan(0.85);
      },
    },
    {
      name: "Case 12: reply to our thread saying 'looks good'",
      json: { intent: "support", confidence: 0.7, rationale: "thank-you reply" },
      assert: (o) => {
        // Both correction and support are acceptable here per spec
        expect(["correction", "support"]).toContain(o[0].intent);
      },
    },
    {
      name: "Case 12a: source_suggestion — mainemade.com",
      json: {
        intent: "source_suggestion",
        ref_url: "https://www.mainemade.com/events/",
        confidence: 0.9,
        rationale: "suggests a source site",
      },
      assert: (o) => {
        expect(o[0].intent).toBe("source_suggestion");
        expect(o[0].refUrl).toContain("mainemade.com");
      },
    },
    {
      name: "Case 12b: multi-intent (source + new_event + correction)",
      json: {
        intents: [
          {
            intent: "source_suggestion",
            ref_url: "https://www.mainemade.com/events/",
            confidence: 0.92,
            rationale: "",
          },
          {
            intent: "new_event",
            sub_intent: "single_url",
            ref_url: "https://facebook.com/event/1",
            confidence: 0.88,
            rationale: "",
          },
          {
            intent: "correction",
            ref_event_clue: "Lilac Festival at Viles Arboretum",
            confidence: 0.91,
            rationale: "",
          },
        ],
      },
      assert: (o) => {
        expect(o).toHaveLength(3);
        expect(o.map((c) => c.intent)).toEqual(["source_suggestion", "new_event", "correction"]);
      },
    },
    {
      name: "Case 12c: correction with venue+name (would need fuzzy match)",
      json: {
        intent: "correction",
        ref_event_clue: "Lilac Festival at Viles Arboretum",
        confidence: 0.87,
        rationale: "date appears incorrect",
      },
      assert: (o) => {
        expect(o[0].intent).toBe("correction");
        expect(o[0].refEventClue).toContain("Lilac Festival");
      },
    },
    {
      name: "Case 12d: correction with submission URL to a rejected event",
      json: {
        intent: "correction",
        ref_url: "https://meetmeatthefair.com/events/some-removed-event",
        confidence: 0.86,
        rationale: "user pointed at our removed event URL",
      },
      assert: (o) => {
        expect(o[0].intent).toBe("correction");
        expect(o[0].refUrl).toContain("meetmeatthefair.com/events/");
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      c.assert(parseClassifierResponse(JSON.stringify(c.json)));
    });
  }
});
