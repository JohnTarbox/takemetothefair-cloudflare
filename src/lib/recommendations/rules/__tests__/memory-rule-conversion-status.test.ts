// Tests for the memory_rule_conversion_status rule. The rule is unusual
// in that its match set comes from a static array in the rule's source
// file rather than D1 — so the assertions check shape contracts (every
// entry yields a well-formed ItemMatch) and the rule definition's
// metadata, not query behavior.

import { describe, it, expect } from "vitest";
import { memoryRuleConversionStatusRule } from "../memory-rule-conversion-status";

describe("memoryRuleConversionStatusRule", () => {
  it("declares the documented rule shape", () => {
    expect(memoryRuleConversionStatusRule.ruleKey).toBe("memory_rule_conversion_status");
    expect(memoryRuleConversionStatusRule.severity).toBe("blue");
    expect(memoryRuleConversionStatusRule.category).toBe("process");
    expect(memoryRuleConversionStatusRule.autoResolve).toBe(true);
  });

  it("returns one match per seeded memory-rule entry", async () => {
    // The static list is small and operator-maintained — assert at least
    // one match exists so an accidental empty-list commit fails CI rather
    // than silently rendering a 0-match rule. If the list is intentionally
    // emptied (all converted), update this expectation in the same commit.
    const matches = await memoryRuleConversionStatusRule.run(
      {} as Parameters<typeof memoryRuleConversionStatusRule.run>[0]
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it("every match carries targetType=memory_rule and a non-empty slug + payload", async () => {
    const matches = await memoryRuleConversionStatusRule.run(
      {} as Parameters<typeof memoryRuleConversionStatusRule.run>[0]
    );
    for (const m of matches) {
      expect(m.targetType).toBe("memory_rule");
      expect(typeof m.targetId).toBe("string");
      expect((m.targetId as string).length).toBeGreaterThan(0);
      expect(m.payload).toBeDefined();
      const payload = m.payload as { description?: string; considerConvertingTo?: string };
      expect(payload.description).toBeTruthy();
      expect(payload.considerConvertingTo).toBeTruthy();
    }
  });

  it("targetIds are unique across the list (otherwise engine dedupe collapses them)", async () => {
    const matches = await memoryRuleConversionStatusRule.run(
      {} as Parameters<typeof memoryRuleConversionStatusRule.run>[0]
    );
    const slugs = matches.map((m) => m.targetId);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
