import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
}

export function registerAnalyticsTools(server: McpServer, auth: AuthContext, env?: Env) {
  // Defense-in-depth: guard even though registration is already gated in index.ts
  if (auth.role !== "ADMIN") return;

  // ── Analytics tools (read-only, proxy to Next.js API) ───────────
  // All tools call the main app's admin analytics endpoints with an
  // X-Internal-Key header. MAIN_APP_URL + INTERNAL_API_KEY must both
  // be set in the MCP worker environment.

  async function fetchAnalyticsJson(path: string): Promise<unknown> {
    if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
      throw new Error(
        "Analytics requires MAIN_APP_URL and INTERNAL_API_KEY to be configured in the MCP server environment."
      );
    }
    const response = await fetch(`${env.MAIN_APP_URL}${path}`, {
      method: "GET",
      headers: { "X-Internal-Key": env.INTERNAL_API_KEY },
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Analytics API returned non-JSON (${response.status}): ${text.slice(0, 200)}`
      );
    }
    if (!response.ok) {
      const errObj = parsed as { error?: string; message?: string };
      throw new Error(
        `Analytics API error (${response.status}): ${errObj.message ?? errObj.error ?? "unknown"}`
      );
    }
    return parsed;
  }

  // Shared Zod schemas for analytics date-range + filter params
  const PRESET_LABELS = [
    "last_7d",
    "last_28d",
    "last_30d",
    "last_90d",
    "last_365d",
    "mtd",
    "ytd",
    "prev_7d",
    "prev_28d",
  ] as const;
  const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  const dateRangeFields = {
    startDate: z
      .string()
      .regex(ISO_DATE_REGEX)
      .optional()
      .describe("Inclusive start date, ISO YYYY-MM-DD. Mutually exclusive with preset."),
    endDate: z
      .string()
      .regex(ISO_DATE_REGEX)
      .optional()
      .describe("Inclusive end date, ISO YYYY-MM-DD. Defaults to yesterday."),
    preset: z
      .enum(PRESET_LABELS)
      .optional()
      .describe(
        "Named date range. Use instead of startDate/endDate. Options: last_7d, last_28d, last_30d, last_90d, last_365d, mtd, ytd, prev_7d, prev_28d."
      ),
  };

  function buildDateQuery(params: {
    startDate?: string;
    endDate?: string;
    preset?: string;
    refresh?: boolean;
  }): URLSearchParams {
    const qs = new URLSearchParams();
    if (params.startDate) qs.set("startDate", params.startDate);
    if (params.endDate) qs.set("endDate", params.endDate);
    if (params.preset) qs.set("preset", params.preset);
    if (params.refresh) qs.set("refresh", "1");
    return qs;
  }

  server.tool(
    "get_analytics_overview",
    "Site-wide GA4 overview: active users, top pages, top events, top traffic sources. Default window is last 28 days ending yesterday; pass preset or startDate/endDate to override. Pass comparePreviousPeriod:true for delta vs the prior equal-length period. Admin only.",
    {
      ...dateRangeFields,
      comparePreviousPeriod: z
        .boolean()
        .optional()
        .describe(
          "When true, response adds previousTotals for the period immediately preceding the requested range. Default false."
        ),
      pathPrefix: z
        .string()
        .optional()
        .describe("Filter topPages array to paths starting with this prefix (e.g. '/blog/')."),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max rows in topPages (default 20, max 200)."),
      orderBy: z
        .enum(["views", "users", "sessions", "engagementRate"])
        .optional()
        .describe("Sort order for topPages (default views)."),
      minViews: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop topPages rows with fewer views than this."),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        if (params.comparePreviousPeriod) qs.set("comparePreviousPeriod", "true");
        if (params.pathPrefix) qs.set("pathPrefix", params.pathPrefix);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        if (params.orderBy) qs.set("orderBy", params.orderBy);
        if (params.minViews !== undefined) qs.set("minViews", String(params.minViews));
        const q = qs.toString();
        const data = await fetchAnalyticsJson(`/api/admin/analytics/ga4${q ? "?" + q : ""}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error fetching overview",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_top_pages",
    "Top pages by traffic over a date window. Defaults to top 20 for the last 28 days; use pathPrefix to scope to a subtree (e.g. '/blog/'), rowLimit to fetch more, orderBy to sort differently. Admin only.",
    {
      ...dateRangeFields,
      pathPrefix: z
        .string()
        .optional()
        .describe("Filter to paths starting with this (e.g. '/blog/', '/events/')."),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max rows to return (default 20, max 200)."),
      orderBy: z
        .enum(["views", "users", "sessions", "engagementRate"])
        .optional()
        .describe("Sort order (default views)."),
      minViews: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop rows with fewer views than this."),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        if (params.pathPrefix) qs.set("pathPrefix", params.pathPrefix);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        if (params.orderBy) qs.set("orderBy", params.orderBy);
        if (params.minViews !== undefined) qs.set("minViews", String(params.minViews));
        const q = qs.toString();
        const data = (await fetchAnalyticsJson(`/api/admin/analytics/ga4${q ? "?" + q : ""}`)) as {
          success: boolean;
          metrics?: { topPages?: unknown; dateRange?: unknown; generatedAt?: string };
        };
        return {
          content: [
            jsonContent({
              topPages: data.metrics?.topPages ?? [],
              dateRange: data.metrics?.dateRange,
              generatedAt: data.metrics?.generatedAt,
            }),
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error listing top pages",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_page_analytics",
    "Detailed analytics for a single page path: totals with period-over-period deltas, daily views series, traffic sources, device breakdown, and GA4 events fired on that page. Defaults to last 28 days; pass preset or startDate/endDate to override. Admin only.",
    {
      path: z
        .string()
        .startsWith("/")
        .describe("URL path, must begin with '/'. Example: '/events' or '/blog/my-post'"),
      ...dateRangeFields,
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("path", params.path);
        const data = await fetchAnalyticsJson(`/api/admin/analytics/page?${qs.toString()}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching page analytics",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_search_queries",
    "Top Google Search Console queries that led to a specific page. Returns query text, clicks, impressions, CTR, and average SERP position. Default window is last 30 days ending 3 days ago (to account for GSC reporting lag). Admin only.",
    {
      path: z
        .string()
        .startsWith("/")
        .describe("URL path, must begin with '/'. Example: '/events' or '/blog/my-post'"),
      ...dateRangeFields,
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 15, max 500)."),
      refresh: z.boolean().optional().describe("Bypass the 15-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("path", params.path);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/search-queries?${qs.toString()}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching search queries",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_top_search_queries",
    "Site-wide top Google Search Console queries aggregated across all pages. Each query row includes its top 3 ranking pages. Filter by pathPrefix (e.g. '/blog/') to scope to a subtree. Default window is last 28 days ending 3 days ago. Use this to find SEO opportunities without walking each page individually. Admin only.",
    {
      ...dateRangeFields,
      pathPrefix: z
        .string()
        .optional()
        .describe(
          "Only include queries where at least one impression came from a path starting with this prefix (e.g. '/blog/')."
        ),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max queries to return (default 50, max 500)."),
      minImpressions: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop queries with fewer impressions than this."),
      orderBy: z
        .enum(["impressions", "clicks", "position", "ctr"])
        .optional()
        .describe("Sort order (default impressions desc; position sorts ascending)."),
      refresh: z.boolean().optional().describe("Bypass the 15-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        if (params.pathPrefix) qs.set("pathPrefix", params.pathPrefix);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        if (params.minImpressions !== undefined)
          qs.set("minImpressions", String(params.minImpressions));
        if (params.orderBy) qs.set("orderBy", params.orderBy);
        const q = qs.toString();
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/search-queries/site${q ? "?" + q : ""}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown error fetching site-wide search queries",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_query_pages",
    "Reverse lookup: given a search query, return every page that ranks for it with per-page clicks, impressions, CTR, and average position. Use to detect keyword cannibalization (multiple pages competing for the same query — none wins). Default window is last 28 days ending 3 days ago. Admin only.",
    {
      query: z
        .string()
        .min(1)
        .describe("The exact search query to look up (e.g. 'fairs in maine')."),
      ...dateRangeFields,
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max pages to return (default 50, max 500)."),
      refresh: z.boolean().optional().describe("Bypass the 15-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("query", params.query);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        const data = await fetchAnalyticsJson(`/api/admin/analytics/query-pages?${qs.toString()}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error fetching query pages",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_event_analytics",
    "Analytics for a single MMATF event: looks up the event record, then returns GA4 page analytics + Search Console queries for its public path (/events/<slug>). Provide either eventId or slug. Default window is last 28 days. Admin only.",
    {
      eventId: z.string().optional().describe("The MMATF event UUID. Use this OR slug, not both."),
      slug: z
        .string()
        .optional()
        .describe(
          "The event slug (e.g. '2026-orono-easter-craft-and-vendor-fair'). Use this OR eventId."
        ),
      ...dateRangeFields,
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      if (!params.eventId && !params.slug) {
        return {
          content: [{ type: "text", text: "Provide either eventId or slug." }],
          isError: true,
        };
      }
      try {
        const qs = buildDateQuery(params);
        if (params.eventId) qs.set("eventId", params.eventId);
        else if (params.slug) qs.set("slug", params.slug);
        const data = await fetchAnalyticsJson(`/api/admin/analytics/event?${qs.toString()}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching event analytics",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_ga4_event_detail",
    "Top parameter-value combinations for a specific GA4 event (e.g. api_error, view_search_results, scroll_depth, form_submit). IMPORTANT: parameters must be registered as custom dimensions in GA4 Admin -> Custom Definitions before they will populate — unregistered params return empty rows even if the event fires them. Use to answer 'which endpoint is erroring most?' or 'what search terms return 0 results?'. Admin only.",
    {
      eventName: z
        .string()
        .min(1)
        .describe(
          "Exact GA4 event name (case-insensitive), e.g. 'api_error', 'view_search_results'."
        ),
      topParameters: z
        .array(z.string().min(1))
        .max(9)
        .optional()
        .describe(
          "Custom event parameter names to break down by (max 9). E.g. ['endpoint','status_code','error_message']. Must be registered as custom dimensions in GA4."
        ),
      path: z
        .string()
        .startsWith("/")
        .optional()
        .describe("Optional: scope to one page path. Must begin with '/' if provided."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of top parameter-value combinations to return (default 20, max 100)."),
      ...dateRangeFields,
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("eventName", params.eventName);
        if (params.topParameters && params.topParameters.length > 0) {
          qs.set("topParameters", params.topParameters.join(","));
        }
        if (params.path) qs.set("path", params.path);
        if (params.topN !== undefined) qs.set("topN", String(params.topN));
        const data = await fetchAnalyticsJson(`/api/admin/analytics/ga4-event?${qs.toString()}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching GA4 event detail",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_internal_search_queries",
    "Top site-search queries that users entered into the MMATF search box, with per-query event counts. Built on the view_search_results GA4 event (fires from the global search component). Default window is last 28 days. Note: the 'search_term' event parameter must be registered as a custom dimension in GA4 Admin for query text to populate — otherwise rows show blank search terms. Admin only.",
    {
      ...dateRangeFields,
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of distinct queries to return (default 50, max 100)."),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("eventName", "view_search_results");
        qs.set("topParameters", "search_term,results_count");
        if (params.rowLimit !== undefined) qs.set("topN", String(params.rowLimit));
        const data = (await fetchAnalyticsJson(
          `/api/admin/analytics/ga4-event?${qs.toString()}`
        )) as {
          success: boolean;
          eventName?: string;
          totalCount?: number;
          dateRange?: unknown;
          topValues?: Array<{ parameters: Record<string, string>; count: number }>;
          generatedAt?: string;
        };
        const queries = (data.topValues ?? []).map((row) => ({
          searchTerm: row.parameters["search_term"] ?? "",
          resultsReturned: row.parameters["results_count"]
            ? Number(row.parameters["results_count"])
            : undefined,
          count: row.count,
        }));
        return {
          content: [
            jsonContent({
              queries,
              totalSearches: data.totalCount ?? 0,
              dateRange: data.dateRange,
              generatedAt: data.generatedAt,
            }),
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown error fetching internal search queries",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_sitemap_status",
    "Lists all sitemaps submitted to Google Search Console with per-sitemap indexed-vs-submitted counts, errors, and warnings. Fast aggregate view for 'how many of our pages are indexed?'. For per-URL diagnosis use get_url_inspection. Data cached 24h. Admin only.",
    {
      refresh: z.boolean().optional().describe("Bypass the 24h cache (default false)."),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams();
        if (params.refresh) qs.set("refresh", "1");
        const q = qs.toString();
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/sitemap-status${q ? "?" + q : ""}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching sitemap status",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_url_inspection",
    "Inspects a single URL via Search Console's URL Inspection API. Returns index verdict, coverage state, last-crawl time, canonicalization, sitemap membership, mobile usability, and rich-results status. Rate-limited by Google to ~2000/day per property; cache 6h. Use to diagnose 'why isn't this page indexed?' — not for bulk audits. Admin only.",
    {
      path: z
        .string()
        .startsWith("/")
        .describe(
          "URL path to inspect, must begin with '/'. Example: '/events' or '/blog/my-post'"
        ),
      refresh: z.boolean().optional().describe("Bypass the 6h cache (default false)."),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams({ path: params.path });
        if (params.refresh) qs.set("refresh", "1");
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/url-inspection?${qs.toString()}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error inspecting URL",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_first_party_events",
    "Query first-party analytics events stored in D1. Includes server-side admin actions (event_status_change, vendor_status_change) and beacon-captured client events (outbound_application_click, outbound_ticket_click, filter_applied, internal_search_performed). Filter by category or event name; default window is the last 30 days. Admin only.",
    {
      category: z
        .string()
        .optional()
        .describe("Filter by category (e.g. 'admin', 'conversion', 'engagement')."),
      name: z
        .string()
        .optional()
        .describe("Filter by exact event name (e.g. 'outbound_application_click')."),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Days back to include. Default 30, max 365."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max recent rows returned. Default 100, max 500."),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams();
        if (params.category) qs.set("category", params.category);
        if (params.name) qs.set("name", params.name);
        if (params.days) qs.set("days", String(params.days));
        if (params.limit) qs.set("limit", String(params.limit));
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/events${qs.toString() ? `?${qs}` : ""}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error fetching events",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_admin_action_log",
    "Recent admin actions captured in first-party analytics: event approvals/rejections, vendor status changes. Filtered to category='admin'. Useful for auditing who did what when. Default window is the last 30 days. Admin only.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Days back to include. Default 30, max 365."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows. Default 100, max 500."),
    },
    async (params) => {
      try {
        const qs = new URLSearchParams({ category: "admin" });
        if (params.days) qs.set("days", String(params.days));
        if (params.limit) qs.set("limit", String(params.limit));
        const data = await fetchAnalyticsJson(`/api/admin/analytics/events?${qs}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching admin action log",
            },
          ],
          isError: true,
        };
      }
    }
  );
}
