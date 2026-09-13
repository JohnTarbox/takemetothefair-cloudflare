/**
 * OPE-954 — the OCR step's result must fit Cloudflare's 1 MiB step-result cap.
 */
import { describe, expect, it } from "vitest";
import {
  boundOcrSources,
  OCR_STEP_BUDGET_BYTES,
  WORKFLOW_STEP_RESULT_MAX_BYTES,
} from "../src/email-handlers/ocr-bounds.js";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const src = (chars: number, name: string, ch = "a") => ({
  kind: "attachment" as const,
  name,
  text: ch.repeat(chars),
});
const OPTS = { perSourceMaxChars: 100_000, budgetBytes: OCR_STEP_BUDGET_BYTES, minChars: 20 };

describe("boundOcrSources", () => {
  it("the budget really is under the cap it protects", () => {
    expect(WORKFLOW_STEP_RESULT_MAX_BYTES).toBe(2 ** 20);
    expect(OCR_STEP_BUDGET_BYTES).toBeLessThan(WORKFLOW_STEP_RESULT_MAX_BYTES);
  });

  it("f8ef71e5 shape: four large OCR results totalling well over 1 MiB now fit, with every cut reported", () => {
    const input = [
      src(400_000, "a.png"),
      src(380_000, "b.png"),
      src(250_000, "c.png"),
      src(240_000, "d.png"),
    ];
    expect(bytes(input)).toBeGreaterThan(WORKFLOW_STEP_RESULT_MAX_BYTES); // the premise
    const r = boundOcrSources(input, OPTS);
    expect(r.bytes).toBeLessThanOrEqual(OCR_STEP_BUDGET_BYTES);
    expect(bytes(r.sources)).toBe(r.bytes);
    expect(r.sources.map((s) => s.name)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(r.sources.every((s) => s.text.length === 100_000)).toBe(true);
    expect(r.truncations).toHaveLength(4);
    expect(r.truncations.every((t) => t.reason === "per-source-cap")).toBe(true);
  });

  it("MULTI-BYTE text is budgeted in bytes, not chars", () => {
    // 100k chars of a 3-byte char is ~300 KB per source; four of them cannot fit.
    const input = [0, 1, 2, 3].map((i) => src(100_000, `m${i}.png`, "€"));
    const r = boundOcrSources(input, OPTS);
    expect(r.bytes).toBeLessThanOrEqual(OCR_STEP_BUDGET_BYTES);
    expect(
      r.truncations.some((t) => t.reason === "step-budget" || t.reason === "dropped-step-budget")
    ).toBe(true);
  });

  it("drops a source only when too little would be left to be a source at all", () => {
    const r = boundOcrSources([src(10, "tiny")], { ...OPTS, budgetBytes: 40 });
    expect(r.sources).toHaveLength(0);
    expect(r.truncations[0].reason).toBe("dropped-step-budget");
  });

  it("POSITIVE LANDMARK: a normal single poster passes through untouched and unreported", () => {
    const input = [src(1_200, "poster.png")];
    const r = boundOcrSources(input, OPTS);
    expect(r.sources).toEqual(input);
    expect(r.truncations).toEqual([]);
  });
});
