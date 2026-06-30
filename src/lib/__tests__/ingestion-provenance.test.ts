import { describe, it, expect } from "vitest";
import { getIngestionProvenance } from "@/lib/ingestion-provenance";

describe("getIngestionProvenance", () => {
  it("classifies machine-found methods as bot", () => {
    for (const m of ["discovery", "web_research", "aggregator_import", "direct_scrape"]) {
      expect(getIngestionProvenance(m).kind).toBe("bot");
    }
  });

  it("classifies genuine submissions as human", () => {
    for (const m of ["community_suggestion", "email_submission", "vendor_submission"]) {
      expect(getIngestionProvenance(m).kind).toBe("human");
    }
  });

  it("labels discovery distinctly from a vendor submission (the core bug)", () => {
    const bot = getIngestionProvenance("discovery");
    const human = getIngestionProvenance("vendor_submission");
    expect(bot.label).not.toBe(human.label);
    expect(bot.kind).toBe("bot");
    expect(human.kind).toBe("human");
  });

  it("treats null/undefined as an unknown system source", () => {
    expect(getIngestionProvenance(null)).toEqual({
      label: "Unknown source",
      kind: "system",
      variant: "default",
    });
    expect(getIngestionProvenance(undefined).kind).toBe("system");
  });

  it("prettifies unlisted methods as readable system labels (no bot/human guess)", () => {
    const p = getIngestionProvenance("annual_rollover");
    expect(p.kind).toBe("system");
    expect(p.label).toBe("Annual Rollover");
  });
});
