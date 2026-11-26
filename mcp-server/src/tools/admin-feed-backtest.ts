/**
 * OPE-1635 — feed analytics 4/5: safe rule changes. MCP tools:
 *
 *   backtest_feed_rules     — read-only. Replays proposed inclusion rules and/or
 *                             matcher settings over the replay corpus and says
 *                             exactly what flips, with each item's label.
 *   record_feed_rule_change — one change-log row per merged rule or matcher
 *                             change: PR, backtest summary, metrics now; the
 *                             hourly cron adds the metrics 7 days on.
 *
 * The change log is READ through get_feed_lane_metrics (`rule_changes`).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import {
  BACKTEST_BASELINE_PRESETS,
  RULE_CHANGE_FOLLOWUP_DAYS,
  recordFeedRuleChange,
  runFeedBacktest,
  type BacktestBaselinePreset,
} from "@takemetothefair/db-schema/feed-backtest";
import type { FeedInclusionRules } from "@takemetothefair/utils/feeds";

const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const patterns = z.array(z.string().max(200)).max(100);
/** A partial FeedInclusionRules, as JSON. Every key optional; a given key REPLACES that key. */
export const rulesArg = z
  .object({
    includeTitlePatterns: patterns.optional(),
    excludeTitlePatterns: patterns.optional(),
    excludeProgramPatterns: patterns.optional(),
    programDescriptionSignals: patterns.optional(),
    excludeOrganizerEmails: patterns.optional(),
    keepMultiDay: z.boolean().optional(),
    defaultInclude: z.boolean().optional(),
  })
  .strict();

/** The first pattern that does not compile as a RegExp, so a typo is an error, not a no-op. */
export function badPattern(r: Partial<FeedInclusionRules> | undefined): string | null {
  if (!r) return null;
  for (const key of [
    "includeTitlePatterns",
    "excludeTitlePatterns",
    "excludeProgramPatterns",
    "programDescriptionSignals",
  ] as const) {
    for (const p of r[key] ?? []) {
      try {
        new RegExp(p, "i");
      } catch (e) {
        return `${key}: /${p}/ — ${(e as Error).message}`;
      }
    }
  }
  return null;
}

export function registerFeedBacktestTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  opts: { now?: () => Date } = {}
) {
  if (auth.role !== "ADMIN") return;
  const now = opts.now ?? (() => new Date());

  server.tool(
    "backtest_feed_rules",
    `OPE-1635 — replay proposed organizer-feed inclusion rules and/or matcher settings over the replay corpus (every feed item's latest snapshot, plus earlier versions with include_history) BEFORE shipping the change. Returns: items that flip included → dropped and dropped → included, each with its ground-truth label when one exists (feed_item_labels rows, plus pre-OPE-1634 reviews read from the item: rejected / review_approve / review_link, marked implied); WRONG-WAY flips first (the proposed verdict contradicts the label); estimated precision and false-drop rate before and after (over labelled items); matches gained / lost / changed by the date + name matcher; and summary_markdown to paste into the PR body (CI requires a '## Backtest' section on any PR that changes the inclusion rules or the matcher). Rules are laid OVER each feed's stored rules (a given key replaces that key). baseline_preset 'pre_ope1629' replays the 2026-11-12 market fix. Read-only — changes nothing. Lists are capped at 50; counts are whole.`,
    {
      proposed_rules: rulesArg
        .optional()
        .describe("Partial inclusion rules for the AFTER side, e.g. {excludeTitlePatterns:[…]}."),
      baseline_rules: rulesArg.optional().describe("Partial rules for the BEFORE side."),
      baseline_preset: z
        .enum(Object.keys(BACKTEST_BASELINE_PRESETS) as [BacktestBaselinePreset])
        .optional()
        .describe("'current' (default: each feed's stored rules) or 'pre_ope1629'."),
      proposed_matcher: z
        .object({ min_name_key_length: z.number().int().min(1).max(40) })
        .partial()
        .strict()
        .optional()
        .describe("Matcher settings for the AFTER side (date + name match)."),
      feed_ids: z.array(z.string().min(1)).max(50).optional(),
      include_history: z
        .boolean()
        .default(false)
        .describe("Also replay each item's earlier versions (promoter_feed_item_snapshots)."),
    },
    async (p) => {
      const bad = badPattern(p.proposed_rules) ?? badPattern(p.baseline_rules);
      if (bad) return err(`a pattern does not compile: ${bad}`);
      const result = await runFeedBacktest(db, {
        feedIds: p.feed_ids,
        proposedRules: p.proposed_rules,
        baselineRules: p.baseline_rules,
        baselinePreset: p.baseline_preset,
        proposedMatcher:
          p.proposed_matcher?.min_name_key_length != null
            ? { minNameKeyLength: p.proposed_matcher.min_name_key_length }
            : undefined,
        includeHistory: p.include_history,
      });
      return { content: [jsonContent(result)] };
    }
  );

  server.tool(
    "record_feed_rule_change",
    `OPE-1635 — record ONE merged change to the organizer-feed inclusion rules or matcher in the change log: when, the PR, the OPE, a one-line summary, and the backtest summary it shipped with (backtest_feed_rules' summary_markdown). Captures get_feed_lane_metrics.quality as it stands now as the "before"; the MCP hourly cron captures it again ${RULE_CHANGE_FOLLOWUP_DAYS} days after changed_at as the "after". Read the log through get_feed_lane_metrics (rule_changes). Writes one feed_rule_changes row; sends nothing.`,
    {
      kind: z.enum(["inclusion", "matcher", "both"]),
      pr: z
        .string()
        .regex(/^#\d+$/, "a PR number, e.g. #1780")
        .optional(),
      ope_id: z
        .string()
        .regex(/^OPE-\d+$/, "an OPE identifier, e.g. OPE-1629")
        .optional(),
      summary: z.string().min(1).max(1000).transform(decodeHtmlEntities),
      backtest: z.string().max(8000).optional(),
      changed_at: z
        .string()
        .datetime()
        .optional()
        .describe("When the change merged (ISO-8601). Default now."),
    },
    async (p) => {
      const at = now();
      const changedAt = p.changed_at ? new Date(p.changed_at) : at;
      if (changedAt.getTime() > at.getTime() + 60_000)
        return err("changed_at is in the future — record a change once it has merged.");
      const r = await recordFeedRuleChange(db, {
        kind: p.kind,
        pr: p.pr ?? null,
        opeId: p.ope_id ?? null,
        summary: p.summary,
        backtest: p.backtest ?? null,
        changedAt,
        now: at,
      });
      return { content: [jsonContent({ ok: true, ...r })] };
    }
  );
}
