// Analyst Item 5f (Phase 2, 2026-05-30): track empirical patterns that
// have been recorded as memory rules (in `.claude/projects/.../memory/`)
// but haven't been promoted to first-class SQL-defined detection rules.
// Tier-3 process surface — informational, lights up conversion backlog
// so the operator can spot high-value automations they haven't built yet.
//
// Why a static list rather than a D1 query: memory rules live in markdown
// files outside the edge-runtime filesystem (no fs access from a Pages
// route). The simplest source of truth is a hand-curated array right
// here. When a memory rule is promoted to a `RuleDefinition` and
// registered in `index.ts`, remove its entry from the list below.
//
// Adjacent rule: `long_snoozed_items` interpreted the same Phase-2 spec
// ("memory_rule_open_status") differently — as snoozed-without-action
// items in the queue. Both rules ship; they capture distinct operator
// concerns. See that file's comment for the divergence history.

import type { ItemMatch, RuleDefinition } from "../engine";

interface MemoryRuleEntry {
  /** Stable slug — used as targetId so the engine can dedupe across
   *  scans and so admin UI can link out (future). Kebab-case, matching
   *  the memory-file naming convention. */
  slug: string;
  /** Short human description of the empirical pattern this memory rule
   *  captures. Should answer "what would the SQL rule detect?" not
   *  "what did Claude do when this happened?" — the former is the
   *  conversion candidate, the latter is operational feedback. */
  description: string;
  /** One-liner on the SQL rule it would become. Concrete enough that
   *  the operator can scope the work without re-reading the memory file. */
  considerConvertingTo: string;
}

// Hand-maintained list. Start small; the operator adds entries as they
// recognize a pattern that would benefit from automatic detection.
// Conservative seed — three patterns currently tracked in memory that
// have not been wired as SQL rules and where conversion has direct
// operational value.
const MEMORY_RULES_PENDING_CONVERSION: MemoryRuleEntry[] = [
  {
    slug: "ms-epoch-timestamp-contamination",
    description:
      "Vendor / event rows with `updated_at` written in milliseconds instead of seconds — surfaces as year-58308 sitemap lastmods. Backfilled 2026-05-22; defensive read-time guard at `src/lib/sitemap-lastmod.ts:correctMsOverflow` catches stragglers.",
    considerConvertingTo:
      "Daily scan: any timestamp column > 1e11 across vendors/events/promoters/blog_posts. Flag the row as data-quality red.",
  },
  {
    slug: "invented-category-fallback",
    description:
      "Events with `categories = ['Event']` — the AI extraction fallback shipped before name-keyword inference (2026-04-28). 17 silently-uncategorized farmers-market rows had to be hand-categorized.",
    considerConvertingTo:
      "Detection: events with categories array == ['Event'] (exact match). Surface for manual recategorization OR retro-AI-classify in batch.",
  },
  {
    slug: "drizzle-timestamp-invalid-date",
    description:
      "D1 timestamp columns containing non-numeric cell values surface as Invalid Date when Drizzle reads them. `||` guards aren't enough — need `!isNaN(d.getTime())`. Pattern repeats across new code that touches timestamp columns without defensive parsing.",
    considerConvertingTo:
      "Detection: scan timestamp columns for cells where CAST(value AS INTEGER) returns 0 but value is not '0'. Flag schemas + counts for code review.",
  },
];

export const memoryRuleConversionStatusRule: RuleDefinition = {
  ruleKey: "memory_rule_conversion_status",
  title: "Memory rules pending conversion to SQL detection",
  rationaleTemplate:
    "{n} empirical patterns are tracked in Claude's memory but haven't yet been promoted to first-class recommendation rules. Convert the high-value ones to automatic detection so future occurrences light up without manual review.",
  severity: "blue",
  category: "process",
  // The list is immutable per render — once an entry is removed (rule
  // shipped), the next scan finds it absent and autoResolve drops the
  // existing item from the open queue.
  autoResolve: true,
  async run(): Promise<ItemMatch[]> {
    return MEMORY_RULES_PENDING_CONVERSION.map((entry) => ({
      targetType: "memory_rule",
      targetId: entry.slug,
      payload: {
        description: entry.description,
        considerConvertingTo: entry.considerConvertingTo,
      },
    }));
  },
};
