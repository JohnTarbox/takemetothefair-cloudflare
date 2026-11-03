/**
 * OPE-1316 Ask 2 — the extraction prompt asks for less output.
 *
 * Measured 2026-10-06: the slow pages were slow because the model wrote every
 * sub-activity of a fair as its own event, with all ~30 fields as null, up to
 * the 4,096-token cap. Both multi-event prompts (page-only and email+page) now
 * ask for top-level events only and tell the model to omit unknown fields, and
 * the worked example no longer models writing nulls.
 */
import { describe, it, expect, vi } from "vitest";
import {
  extractMultipleEvents,
  INTERACTIVE_AI_EXTRACT_TIMEOUT_MS,
} from "@/lib/url-import/ai-extractor";

function capture() {
  const prompts: string[] = [];
  const ai = {
    run: vi.fn(async (_m: string, input: { messages: Array<{ content: string }> }) => {
      prompts.push(input.messages[1].content);
      return { response: "[]" };
    }),
  };
  return { ai, prompts };
}

describe("OPE-1316 Ask 2 — output-cut prompt", () => {
  for (const [label, emailBody] of [
    ["page-only prompt", undefined],
    ["email + page prompt", "See you at the Heath Fair, August 21!"],
  ] as const) {
    it(`${label}: top-level events only, omit unknown fields, example writes no nulls`, async () => {
      const { ai, prompts } = capture();
      await extractMultipleEvents(
        ai as never,
        "Heath Fair. Tractor pull. Sheep show.",
        {},
        emailBody
      );
      const p = prompts[0];
      expect(p).toContain("TOP-LEVEL EVENTS ONLY");
      expect(p).toMatch(/tractor pull, sheep show, gymkhana/);
      expect(p).toContain("OMIT any field the source does not state");
      expect(p).not.toContain("use null for fields not found");
      // The worked example (page-only prompt) models omission, not nulls.
      const example = p.split("EXAMPLE")[1] ?? "";
      expect(example).not.toContain(":null");
    });
  }

  it("the limit passed in is the one enforced; the default stays the interactive 20 s", async () => {
    expect(INTERACTIVE_AI_EXTRACT_TIMEOUT_MS).toBe(20_000);
    const slow = { run: () => new Promise((r) => setTimeout(() => r({ response: "[]" }), 200)) };
    await expect(extractMultipleEvents(slow as never, "x", {}, undefined, 50)).rejects.toThrow(
      /timed out/
    );
    await expect(
      extractMultipleEvents(slow as never, "x", {}, undefined, 1_000)
    ).resolves.toBeTruthy();
  });
});
