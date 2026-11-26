/**
 * OPE-1636 part B — recurring feed discovery over MCP.
 *
 *   probe_promoter_feeds          probe named promoters now (read-only: writes nothing);
 *   list_feed_discovery_runs      the monthly runs, each with the analyst task ready to file;
 *   record_feed_discovery_filing  stamp a run with the OPE filed for it.
 *
 * The monthly run itself is the MCP hourly cron (feeds/discovery-run.ts).
 * Registration stays a human decision: the analyst proposes, an operator calls
 * register_promoter_feed, and every feed starts with questions_hold on.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import {
  listFeedDiscoveryRuns,
  monthOf,
  probePromoter,
  recordFeedDiscoveryFiling,
  type DiscoveryRunView,
} from "../feeds/discovery-run.js";

export const FEED_DISCOVERY_AGENT = "analyst-claude-desktop";
const PROBE_MAX = 25;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** The analyst task for one completed run: title + markdown body. Pure. */
export function discoveryTicket(r: DiscoveryRunView): { title: string; body: string } {
  const title = `[agent instructions][${FEED_DISCOVERY_AGENT}][task] Feed discovery, month of ${monthName(r.month)}: ${r.new_candidates.length} promoter${r.new_candidates.length === 1 ? "" : "s"} with a new feed candidate`;
  const L: string[] = [];
  L.push(
    `The monthly feed discovery run for ${monthName(r.month)} probed **${r.probed} of ${r.eligible}** eligible promoters (a website, no registered feed)${r.partial ? " — a PARTIAL month: the rest are probed first next month" : ""}. ${r.found} had a candidate; **${r.new_candidates.length}** are new this month and listed below. Run row: \`feed_discovery_runs.month = '${r.month}'\` (OPE-1636).`
  );
  L.push("");
  L.push(
    "**Ask:** for each promoter, propose register / skip with a reason. Registration stays a human decision: `register_promoter_feed`, and every feed starts with `questions_hold` on. A `provider_hosted` calendar (Google, Outlook…) needs a validated contact to register, not the domain."
  );
  L.push("");
  for (const p of r.new_candidates) {
    L.push(`### ${p.promoter ?? p.promoter_id}`);
    L.push(`promoter \`${p.promoter_id}\` · ${p.website ?? "no website"}`);
    for (const c of p.candidates) {
      const sample = c.sample_titles.length
        ? ` — e.g. ${c.sample_titles.map((t) => `“${t}”`).join(", ")}`
        : "";
      L.push(
        `- **${c.kind}** ${c.feed_url} (${c.found_via}${c.provider_hosted ? ", provider_hosted" : ""}): ${c.item_count} item${c.item_count === 1 ? "" : "s"}${sample}`
      );
    }
    L.push("");
  }
  if (r.blocked.length) {
    L.push(
      `**Blocked (403, not probed further — we do not get around a block):** ${r.blocked.map((b) => b.promoter ?? b.promoter_id).join(", ")}`
    );
    L.push("");
  }
  return { title, body: L.join("\n") };
}

export function registerFeedDiscoveryTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  opts: { now?: () => Date; fetchImpl?: typeof fetch } = {}
) {
  if (auth.role !== "ADMIN") return;
  const now = opts.now ?? (() => new Date());

  server.tool(
    "probe_promoter_feeds",
    `OPE-1636 — probe promoters' OWN sites for a usable event feed, now. For each promoter id (max ${PROBE_MAX}), checks only domains on its domain list (OPE-1614 matchableDomainsFor; a promoter with none returns outcome no_domain): The Events Calendar REST API (/wp-json/tribe/events/v1/events) and, when it answers, the plugin's iCal URL (/events/?ical=1); iCal links and published Google Calendar embeds on the home page; schema.org Event JSON-LD on the home page and the linked events page. Returns per promoter: outcome (found | none | blocked | error | no_domain) and candidates, each with kind (tec_rest | ical | jsonld), feed_url (what register_promoter_feed takes), found_via, item_count, up to 5 sample titles, and provider_hosted (a calendar on Google/Outlook needs a validated contact to register). Polite: the feed reader's User-Agent, a timeout and size cap per request; a 403 ends that domain's probe (blocked) — never evaded. READ-ONLY: writes nothing (the monthly cron records its own probes).`,
    { promoter_ids: z.array(z.string().min(1)).min(1).max(PROBE_MAX) },
    async (p) => {
      const at = now();
      const results = [];
      for (const id of p.promoter_ids)
        results.push(await probePromoter(db, id, { now: at, fetchImpl: opts.fetchImpl }));
      return {
        content: [
          jsonContent({
            probed: results.length,
            found: results.filter((r) => r.outcome === "found").length,
            requests: results.reduce((n, r) => n + r.requests, 0),
            results,
          }),
        ],
      };
    }
  );

  server.tool(
    "list_feed_discovery_runs",
    `OPE-1636 — the monthly feed discovery runs (newest first, default 3; or one month YYYY-MM): eligible / probed / found counts, completed_at (null while the hourly cron is still probing; partial when the month ended first), ope_id once filed, the NEW candidates (feed URLs no earlier month found, on promoters still without a feed) and the blocked promoters. \`to_file\`: every COMPLETED run not yet filed, with the analyst task ready to file — title (routed to ${FEED_DISCOVERY_AGENT}) and markdown body. File it with Linear save_issue (team OPE, project "Personal Agent Engine", label agent-instructions, state Agent Todo), then call record_feed_discovery_filing. A completed run with no new candidates is listed with no ticket; stamp it with ope_id "none" to close it. Read-only.`,
    {
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
      limit: z.number().int().min(1).max(12).default(3),
    },
    async (p) => {
      const runs = await listFeedDiscoveryRuns(db, { month: p.month, limit: p.limit });
      const toFile = runs
        .filter((r) => r.completed_at && !r.ope_id)
        .map((r) => ({
          month: r.month,
          ticket: r.new_candidates.length ? discoveryTicket(r) : null,
        }));
      return { content: [jsonContent({ current_month: monthOf(now()), to_file: toFile, runs })] };
    }
  );

  server.tool(
    "record_feed_discovery_filing",
    `OPE-1636 — stamp a feed discovery run (month YYYY-MM) with the OPE filed for it (e.g. "OPE-1720"), or "none" for a completed run with no new candidates. Idempotent for the same id; refuses to overwrite a run already stamped with a different id. Clears the feed-discovery-filed heartbeat for that run.`,
    {
      month: z.string().regex(/^\d{4}-\d{2}$/),
      ope_id: z.string().regex(/^(OPE-\d+|none)$/),
    },
    async (p) => {
      const r = await recordFeedDiscoveryFiling(db, p.month, p.ope_id, now());
      return r.ok ? { content: [jsonContent(r)] } : { content: [jsonContent(r)], isError: true };
    }
  );
}
