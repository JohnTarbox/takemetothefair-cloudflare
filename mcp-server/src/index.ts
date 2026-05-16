import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoginHandler } from "./oauth/login-handler.js";
import { getDb } from "./db.js";
import { authenticateToken } from "./auth.js";
import { registerPublicTools } from "./tools/public.js";
import { registerUserTools } from "./tools/user.js";
import { registerVendorTools } from "./tools/vendor.js";
import { registerPromoterTools } from "./tools/promoter.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerBlogTools } from "./tools/blog.js";
import { registerContentLinksTools } from "./tools/content-links.js";
import type { AuthContext } from "./auth.js";
import type { UserProps } from "./oauth/utils.js";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
  // Optional Pages service binding — bound in production via wrangler.toml,
  // typically absent in local dev. When present, internal API calls (IndexNow
  // ping, future cross-Worker calls) skip the public-internet round-trip.
  MAIN_APP?: Fetcher;
  // Cloudflare Queues — producer side. Same bindings as the main app, so
  // MCP tools can enqueue work to the same consumer (this Worker, below).
  EMAIL_JOBS?: Queue;
  INDEXNOW_PINGS?: Queue;
  // Resend API key — consumer needs it to actually send emails. Set via
  // `wrangler secret put RESEND_API_KEY`.
  RESEND_API_KEY?: string;
  // IndexNow API key — same pattern, for the queue consumer to call
  // api.indexnow.org directly without going through the main app.
  INDEXNOW_KEY?: string;
  // Build fingerprint — injected by `wrangler deploy --var` at deploy time.
  // Empty in local dev; populated in production so `whoami` can answer
  // "which bundle is the server running?" without a client round-trip.
  GIT_SHA?: string;
  BUILD_TIME?: string;
}

// ---------------------------------------------------------------------------
// Durable Object — MCP agent with OAuth-provided user props
// ---------------------------------------------------------------------------
export class MeetMeAtTheFairMCP extends McpAgent<Env, Record<string, never>, UserProps> {
  // Type assertion needed: @modelcontextprotocol/sdk and agents bundle separate
  // copies of McpServer with incompatible private fields but identical public API.
  server = new McpServer({
    name: "MeetMeAtTheFair",
    version: "1.0.0",
  }) as any;

  async init() {
    const db = getDb(this.env.DB);

    // Track which tools each register*() call added, so `whoami` can report
    // counts and names sourced from the live McpServer registry — the same
    // registry that `tools/list` iterates. Hardcoded counts drift silently;
    // this can't.
    const snapshot = (): Set<string> =>
      new Set(Object.keys((this.server as any)._registeredTools ?? {}));
    const diff = (before: Set<string>): string[] => [...snapshot()].filter((n) => !before.has(n));
    const groups: Record<string, string[]> = {};

    // Public tools — always available
    let before = snapshot();
    registerPublicTools(this.server, db);
    groups.public = diff(before);

    // Diagnostic tool — registered before role-gated tools, but reads `groups`
    // at call time via closure, so later register*() calls populate it.
    const props = this.props;
    const env = this.env;
    const build = {
      serverName: "MeetMeAtTheFair",
      serverVersion: "1.0.0",
      gitSha: env.GIT_SHA || "unknown",
      buildTime: env.BUILD_TIME || "unknown",
    };
    before = snapshot();
    this.server.tool(
      "whoami",
      "Check your authentication status and see which tools are available.",
      {},
      async () => {
        if (!props) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ authenticated: false, build }, null, 2),
              },
            ],
          };
        }
        const toolSets: string[] = [
          `public tools (${groups.public.length})`,
          `user tools (${groups.user?.length ?? 0})`,
        ];
        if (groups.vendor?.length) {
          toolSets.push(
            props.vendorId
              ? `vendor tools (${groups.vendor.length})`
              : `vendor tools (${groups.vendor.length} — suggest_event only, no vendor profile)`
          );
        }
        if (groups.promoter?.length) toolSets.push(`promoter tools (${groups.promoter.length})`);
        if (groups.admin?.length) toolSets.push(`admin tools (${groups.admin.length})`);
        if (groups.analytics?.length) toolSets.push(`analytics tools (${groups.analytics.length})`);
        if (groups.blog?.length) toolSets.push(`blog tools (${groups.blog.length})`);
        if (groups.contentLinks?.length)
          toolSets.push(`content-links tools (${groups.contentLinks.length})`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  authenticated: true,
                  userId: props.userId,
                  email: props.email,
                  role: props.role,
                  vendorId: props.vendorId || null,
                  promoterId: props.promoterId || null,
                  build,
                  toolSets,
                  tools: {
                    public: groups.public,
                    diagnostic: groups.diagnostic ?? [],
                    user: groups.user ?? [],
                    vendor: groups.vendor ?? [],
                    promoter: groups.promoter ?? [],
                    admin: groups.admin ?? [],
                    analytics: groups.analytics ?? [],
                    blog: groups.blog ?? [],
                    contentLinks: groups.contentLinks ?? [],
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
    groups.diagnostic = diff(before);

    // Role-specific tools based on OAuth props
    if (this.props) {
      const auth: AuthContext = {
        userId: this.props.userId,
        role: this.props.role as AuthContext["role"],
        vendorId: this.props.vendorId,
        promoterId: this.props.promoterId,
      };

      before = snapshot();
      registerUserTools(this.server, db, auth);
      groups.user = diff(before);

      if (auth.role === "VENDOR" || auth.role === "ADMIN") {
        console.log(
          `[INIT] Registering vendor tools for role=${auth.role} vendorId=${auth.vendorId || "none"}`
        );
        before = snapshot();
        registerVendorTools(this.server, db, auth, this.env);
        groups.vendor = diff(before);
      }
      if (auth.role === "PROMOTER" || auth.role === "ADMIN") {
        before = snapshot();
        registerPromoterTools(this.server, db, auth);
        groups.promoter = diff(before);
      }
      if (auth.role === "ADMIN") {
        before = snapshot();
        registerAdminTools(this.server, db, auth, this.env);
        groups.admin = diff(before);

        before = snapshot();
        registerAnalyticsTools(this.server, auth, this.env);
        groups.analytics = diff(before);

        before = snapshot();
        registerBlogTools(this.server, db, auth, this.env);
        groups.blog = diff(before);

        before = snapshot();
        registerContentLinksTools(this.server, db, auth);
        groups.contentLinks = diff(before);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Workaround for issue #121 / upstream MCP TS SDK #1186 (open, P2):
  // "Zombie Task Collision in StreamableHTTPServerTransport"
  //
  // The agents package's StreamableHTTPServerTransport.send() routes responses
  // by walking agent.getConnections() and picking the first connection whose
  // state.requestIds includes the response's request id. When two concurrent
  // clients (or one client reusing JSON-RPC ids across parallel requests) end
  // up with the same id in their per-connection state, the find() returns
  // either connection arbitrarily. Result: the response is written to the
  // wrong client's HTTP socket — silently, with the wrong shape.
  //
  // We hit this in production on 2026-05-10 (8 parallel update_event MCP calls,
  // 3 returned page_analytics-shaped responses). Filed upstream with concurrent-
  // variant analysis.
  //
  // This wrap doesn't fix the routing — that requires a transport-level change
  // (composite (streamId, requestId) keys, or upstream's id-collision rejection).
  // What it DOES is structured-log every collision detection so we can quantify
  // recurrence in `wrangler tail` and confirm when an upstream fix takes effect.
  //
  // Removable when: agents package upgrades past the upstream SDK fix for #1186.
  async onStart(props?: UserProps) {
    await super.onStart(props);
    // Access the protected `_transport` via `any` cast — agents package doesn't
    // expose it for instrumentation but it's safe to read after onStart.
    const transport = (this as unknown as { _transport?: unknown })._transport as
      | { send?: (m: unknown, o?: { relatedRequestId?: unknown }) => Promise<unknown> }
      | undefined;
    if (!transport || typeof transport.send !== "function") return;

    const originalSend = transport.send.bind(transport);
    const getConnections = () => this.getConnections();
    transport.send = async (m: unknown, o?: { relatedRequestId?: unknown }) => {
      const message = m as { id?: unknown };
      const reqId = o?.relatedRequestId ?? message?.id;
      if (reqId !== undefined && reqId !== null) {
        const conns = Array.from(getConnections() ?? []);
        const matches = conns.filter((c) => {
          const ids = (c.state as { requestIds?: unknown[] } | undefined)?.requestIds;
          return Array.isArray(ids) && ids.includes(reqId);
        });
        if (matches.length > 1) {
          console.error(
            `[MCP/#121] JSON-RPC id collision detected — request id ${String(reqId)} matches ${matches.length} active connections. Response routing is ambiguous; one or more clients will receive the wrong response shape. See upstream modelcontextprotocol/typescript-sdk#1186.`
          );
        }
      }
      return originalSend(m, o);
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth provider — handles /register, /authorize, /token, and routes /mcp to DO
// ---------------------------------------------------------------------------
const oauthProvider = new OAuthProvider({
  apiHandlers: {
    "/mcp": MeetMeAtTheFairMCP.serve("/mcp"),
    "/sse": MeetMeAtTheFairMCP.serveSSE("/sse"),
  },
  defaultHandler: LoginHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

// ---------------------------------------------------------------------------
// CORS helpers (for legacy mmatf_ token requests)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://meetmeatthefair.com",
  "https://www.meetmeatthefair.com",
  "http://localhost:3000",
];

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get("Origin") || "";
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    return origin || ALLOWED_ORIGINS[0];
  }
  return ALLOWED_ORIGINS[0];
}

// ---------------------------------------------------------------------------
// Legacy stateless handler for mmatf_ Bearer tokens
// ---------------------------------------------------------------------------
async function handleLegacyMcpRequest(request: Request, env: Env): Promise<Response> {
  const { WebStandardStreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");

  const corsOrigin = getCorsOrigin(request);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
        "Access-Control-Expose-Headers": "mcp-session-id",
      },
    });
  }

  const db = getDb(env.DB);
  const server = new McpServer({ name: "MeetMeAtTheFair", version: "1.0.0" });

  registerPublicTools(server, db);

  const authHeader = request.headers.get("Authorization");
  const auth = await authenticateToken(db, authHeader);

  if (auth) {
    registerUserTools(server, db, auth);
    if (auth.role === "VENDOR" || auth.role === "ADMIN") registerVendorTools(server, db, auth, env);
    if (auth.role === "PROMOTER" || auth.role === "ADMIN") registerPromoterTools(server, db, auth);
    if (auth.role === "ADMIN") {
      registerAdminTools(server, db, auth, env);
      registerAnalyticsTools(server, auth, env);
      registerBlogTools(server, db, auth, env);
      registerContentLinksTools(server, db, auth);
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const response = await transport.handleRequest(request);

  const corsHeaders = new Headers(response.headers);
  corsHeaders.set("Access-Control-Allow-Origin", corsOrigin);
  corsHeaders.set("Access-Control-Expose-Headers", "mcp-session-id");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: corsHeaders,
  });
}

// ---------------------------------------------------------------------------
// Cron Triggers — scheduled handler
// ---------------------------------------------------------------------------
//
// Wraps a few daily/hourly housekeeping tasks that previously required an
// admin to click a button or rely on an external scheduler. Each invocation
// fans out to main-app sweep endpoints via the MAIN_APP service binding so
// the work happens in the main app's request context (D1, KV, Bing/GSC
// secrets, etc.) — keeping the MCP worker focused on MCP and treating the
// main app as the system-of-record for sweeps.
//
// Conservative rollout: only the recommendations-scan task is wired today.
// site-health/sweep + vendors/sweep-enhanced use external secrets and have
// destructive surface area (Bing API quota, vendor flag flips); they'll be
// added incrementally once we trust the cron pattern.
//
// On schedule failure: cron-triggered errors don't surface to a user; they
// land in `wrangler tail` only. We log them to console.error for visibility
// and skip the failed task — never throw, otherwise Cloudflare retries the
// whole cron run on a tighter schedule.
/**
 * Shared executor for cron-driven main-app sweeps. Each task is a POST to a
 * `/api/admin/...` route with `X-Internal-Key`. Errors are logged and
 * swallowed — never thrown — so a single task failure doesn't trigger
 * Cloudflare's tighter-schedule cron retry.
 */
async function runMainAppSweep(
  env: Env,
  label: string,
  path: string,
  format: (result: Record<string, unknown>) => string = (r) => JSON.stringify(r)
): Promise<void> {
  const url = `https://meetmeatthefair.com${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
    },
  };
  try {
    const response = env.MAIN_APP
      ? await env.MAIN_APP.fetch(new Request(url, init))
      : await fetch(url, init);
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      console.error(`[cron] ${label} ${response.status}: ${text}`);
      return;
    }
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    console.warn(`[cron] ${label} ok — ${format(result)}`);
  } catch (error) {
    console.error(`[cron] ${label} threw:`, error);
  }
}

async function runScheduledRecommendationsScan(env: Env): Promise<void> {
  // The /api/admin/recommendations/scan endpoint is chunked to fit Cloudflare's
  // 30s per-request budget (PR #153). Single POST only scans the first 8
  // rules; loop with ?cursor=N until { more: false } to cover ALL_RULES.
  // Hard ceiling of 50 chunks defends against a runaway server bug.
  const MAX_CHUNKS = 50;
  let cursor = 0;
  let chunks = 0;
  const totals = { scannedRules: 0, inserted: 0, resolved: 0, failedRules: 0 };
  while (chunks < MAX_CHUNKS) {
    chunks++;
    const url = `https://meetmeatthefair.com/api/admin/recommendations/scan?cursor=${cursor}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
      },
    };
    try {
      const response = env.MAIN_APP
        ? await env.MAIN_APP.fetch(new Request(url, init))
        : await fetch(url, init);
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        console.error(`[cron] recommendations scan chunk@${cursor} ${response.status}: ${text}`);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        data?: {
          scannedRules?: number;
          inserted?: number;
          resolved?: number;
          failedRules?: number;
          nextCursor?: number;
          more?: boolean;
        };
      };
      const d = body.data;
      if (!d) {
        console.error(`[cron] recommendations scan chunk@${cursor} returned no data`);
        return;
      }
      totals.scannedRules += d.scannedRules ?? 0;
      totals.inserted += d.inserted ?? 0;
      totals.resolved += d.resolved ?? 0;
      totals.failedRules += d.failedRules ?? 0;
      cursor = d.nextCursor ?? cursor;
      if (!d.more) break;
    } catch (error) {
      console.error(`[cron] recommendations scan chunk@${cursor} threw:`, error);
      return;
    }
  }
  console.warn(
    `[cron] recommendations scan ok — scanned=${totals.scannedRules} resolved=${totals.resolved} failed=${totals.failedRules} chunks=${chunks}`
  );
}

/**
 * §6.3 KPI state-machine recompute — fires every 10 min via the
 * star-slash-10 cron. Reads the 5 executive KPIs against the 48h-stable
 * window, classifies, and appends rows to kpi_state_history. Drives the
 * Overview tab's GREEN/YELLOW/RED card coloring + the action queue.
 */
async function runScheduledKpiRecompute(env: Env): Promise<void> {
  await runMainAppSweep(
    env,
    "kpi recompute",
    "/api/admin/kpi-recompute",
    (r) =>
      `written=${r.written} transitions=${r.transitions} resolved=${r.resolved} pruned=${r.pruned}`
  );
}

/**
 * GSC URL Inspection sweep — populates gsc_inspection_state which the
 * time-to-index reconcile then joins against. Daily cadence is enough for
 * MMATF's URL volume (~few hundred URLs/day in time_to_index_log).
 */
async function runScheduledGscSweep(env: Env): Promise<void> {
  await runMainAppSweep(
    env,
    "gsc sweep",
    "/api/admin/site-health/sweep",
    (r) => `inspected=${r.inspected ?? "?"}`
  );
}

/**
 * Time-to-index reconciliation — joins time_to_index_log unresolved rows
 * against gsc_inspection_state. Runs after the gsc sweep so freshly-fetched
 * inspection state can be picked up immediately.
 */
async function runScheduledTimeToIndexSweep(env: Env): Promise<void> {
  await runMainAppSweep(
    env,
    "time-to-index sweep",
    "/api/admin/sweep-time-to-index",
    (r) => `reconciled=${r.reconciled ?? "?"} avg_lag=${r.avg_lag_seconds ?? "?"}s`
  );
}

/**
 * Periodic re-verification sweep for event start_date drift. Reads APPROVED
 * events with start_date 30-90 days out, refetches the canonical source URL,
 * and records drift > 1 day in event_date_drift_findings. The
 * event_date_drift recommendation rule surfaces drift to admin triage.
 *
 * Sweep is chunked (200 events / call) and may iterate via next_cursor if a
 * single chunk doesn't cover the active window. Hard ceiling 50 chunks to
 * guard against a runaway server bug.
 */
async function runScheduledEventDateDrift(env: Env): Promise<void> {
  const MAX_CHUNKS = 50;
  let cursor = 0;
  let chunks = 0;
  const totals = { scanned: 0, drift_recorded: 0, fetch_failed: 0 };
  while (chunks < MAX_CHUNKS) {
    chunks++;
    const url = `https://meetmeatthefair.com/api/admin/event-date-drift/sweep?cursor=${cursor}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
      },
    };
    try {
      const response = env.MAIN_APP
        ? await env.MAIN_APP.fetch(new Request(url, init))
        : await fetch(url, init);
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        console.error(`[cron] event-date-drift sweep chunk@${cursor} ${response.status}: ${text}`);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        scanned?: number;
        drift_recorded?: number;
        fetch_failed?: number;
        next_cursor?: number | null;
      };
      totals.scanned += body.scanned ?? 0;
      totals.drift_recorded += body.drift_recorded ?? 0;
      totals.fetch_failed += body.fetch_failed ?? 0;
      if (body.next_cursor == null) break;
      cursor = body.next_cursor;
    } catch (error) {
      console.error(`[cron] event-date-drift sweep chunk@${cursor} threw:`, error);
      return;
    }
  }
  console.warn(
    `[cron] event-date-drift sweep ok — scanned=${totals.scanned} drift=${totals.drift_recorded} fetch_failed=${totals.fetch_failed} chunks=${chunks}`
  );
}

/**
 * §6.3 Phase 2 GA4 liveness check — daily belt-and-suspenders detection
 * for the failure mode that caused the 2026-04-27 → 2026-05-05 silent
 * outage. Pings GA4 once a day; on 2 consecutive critical/degraded fires,
 * writes admin_actions.ga4.liveness_alert which surfaces as a P0 in the
 * action queue.
 */
async function runScheduledGa4LivenessCheck(env: Env): Promise<void> {
  await runMainAppSweep(
    env,
    "ga4 liveness check",
    "/api/admin/ga4-liveness",
    (r) =>
      `status=${r.status} maxDate=${r.maxDataDate ?? "null"} consecutive=${r.consecutiveFailures} alertFired=${r.alertFired}`
  );
}

/**
 * Hourly drain of pending_search_pings (deferred IndexNow outbox).
 *
 * Bulk-ingest workflows pair `defer_search_ping: true` writes with an
 * explicit `flush_pending_search_pings` call at end of batch. This cron is
 * the safety net: rows queued without a paired flush still drain within an
 * hour, so a forgotten flush doesn't silently leak entities from the index.
 * max_age_seconds=3600 means we only sweep rows that have been waiting at
 * least an hour — leaving fresh bulk-run drains to the explicit flush call.
 */
async function runScheduledPendingPingsFlush(env: Env): Promise<void> {
  try {
    const { getDb } = await import("./db.js");
    const { claimAndFlush } = await import("./pending-pings.js");
    const db = getDb(env.DB);
    const result = await claimAndFlush(db, env, {
      entityType: "all",
      maxAgeSeconds: 3600,
      source: "cron-flush",
    });
    console.warn(
      `[cron] pending-pings flush ok — flushed=${result.flushedCount} batch=${result.batchId} indexnow=${result.indexnowResponse}`
    );
  } catch (error) {
    console.error("[cron] pending-pings flush threw:", error);
  }
}

// ---------------------------------------------------------------------------
// Workflow exports
// ---------------------------------------------------------------------------
//
// Cloudflare Workflows require the WorkflowEntrypoint class to be exported
// from the Worker entry module. The wrangler.toml [[workflows]] binding
// matches by `class_name`. See mcp-server/src/workflows/ for the impls.
export { SchemaOrgSyncWorkflow } from "./workflows/schema-org-sync.js";

// ---------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------
//
// Two queues land here:
//   - email-jobs    → drain & send via Resend (fan-out, max_batch_size=10)
//   - indexnow-pings → aggregate URLs across batch, single Bing submit
//
// Dispatch by `batch.queue` since a single Worker can subscribe to multiple
// queues and the handler needs to know which one fired. Implementations
// live in queue-consumers.ts to keep this file focused on routing.
import { handleEmailBatch, handleIndexNowBatch } from "./queue-consumers.js";

type EmailJobMessage = Parameters<typeof handleEmailBatch>[0]["messages"][number]["body"];
type IndexNowMessage = Parameters<typeof handleIndexNowBatch>[0]["messages"][number]["body"];

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue === "email-jobs") {
      await handleEmailBatch(batch as MessageBatch<EmailJobMessage>, env);
      return;
    }
    if (batch.queue === "indexnow-pings") {
      await handleIndexNowBatch(batch as MessageBatch<IndexNowMessage>, env);
      return;
    }
    console.warn(`[queue] unknown queue '${batch.queue}' — acking without action`);
    for (const m of batch.messages) m.ack();
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Dispatch by cron expression. wrangler.toml lists each cron; the
    // ScheduledController carries which one fired in `controller.cron`.
    //   - "0 6 * * *"     → daily heavy work (recs, gsc, time-to-index)
    //   - "*/10 * * * *"  → §6.3 KPI state-machine recompute (light)
    //   - "0 * * * *"     → hourly: drain pending_search_pings older than 1h
    console.warn(
      `[cron] firing for cron='${controller.cron}' at ${new Date(controller.scheduledTime).toISOString()}`
    );
    if (controller.cron === "*/10 * * * *") {
      ctx.waitUntil(runScheduledKpiRecompute(env));
      return;
    }
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(runScheduledPendingPingsFlush(env));
      return;
    }
    // Default daily branch (covers "0 6 * * *" and any future daily crons).
    ctx.waitUntil(
      Promise.all([
        runScheduledRecommendationsScan(env),
        runScheduledGscSweep(env),
        runScheduledTimeToIndexSweep(env),
        runScheduledGa4LivenessCheck(env),
        runScheduledEventDateDrift(env),
      ]).then(() => undefined)
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const authHeader = request.headers.get("Authorization");

    // Log all requests for debugging
    console.log(`[MCP] ${request.method} ${url.pathname} auth=${authHeader ? "yes" : "no"}`);

    // Root URL health check — Claude.ai probes this before starting OAuth
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({ name: "MeetMeAtTheFair", version: "1.0.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Public build-fingerprint endpoint — no auth, no MCP protocol. Any client
    // can curl this and compare gitSha to `git log` on the repo to verify they
    // are talking to the latest deployed bundle.
    if (url.pathname === "/version" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          name: "MeetMeAtTheFair",
          serverVersion: "1.0.0",
          gitSha: env.GIT_SHA || "unknown",
          buildTime: env.BUILD_TIME || "unknown",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Legacy mmatf_ tokens bypass OAuth and use the stateless handler
    if (url.pathname === "/mcp" && authHeader?.includes("mmatf_")) {
      return handleLegacyMcpRequest(request, env);
    }

    // Everything else goes through the OAuth provider
    try {
      const response = await oauthProvider.fetch(request, env, ctx);
      console.log(`[MCP] ${url.pathname} → ${response.status}`);
      return response;
    } catch (err: any) {
      console.error("[MCP] OAuthProvider error:", err?.message, err?.stack);
      return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
