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
import { handleInboundEmail, type ForwardableEmailMessage } from "./email-handler.js";
import {
  runInboundEmailStaleSweep,
  runScheduledInboundEmailStaleSweep,
} from "./inbound-email-stale-sweep.js";
import { logError } from "./logger.js";
import { inboundEmails } from "./schema.js";
import { eq } from "drizzle-orm";
import type { SchemaOrgSyncParams } from "./workflows/schema-org-sync.js";
import type { RecommendationsScanParams } from "./workflows/recommendations-scan.js";
import type { EventDateDriftParams } from "./workflows/event-date-drift.js";
import type { InboundEmailParams } from "./workflows/inbound-email.js";
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
  // Cloudflare Email Service outbound binding (public beta). The EMAIL_JOBS
  // consumer uses this to send transactional/auto-reply mail. Bound via
  // `[[send_email]]` in wrangler.toml — no API key needed.
  EMAIL?: SendEmail;
  // IndexNow API key — same pattern, for the queue consumer to call
  // api.indexnow.org directly without going through the main app.
  INDEXNOW_KEY?: string;
  // Where inbound emails are forwarded when we can't process them
  // (parse failure, no URL, extract/submit failure). Must be a verified
  // destination address in Cloudflare Email Routing. Set via
  // `wrangler secret put SUBMIT_ADMIN_FORWARD` (or as a [vars] entry).
  SUBMIT_ADMIN_FORWARD?: string;
  // Cloudflare Workflows bindings. SCHEMA_ORG_SYNC is also reachable
  // from Pages via the HTTP escape hatch at
  // /api/admin/workflows/schema-org-sync/*. The other two are
  // cron-only (fired from scheduled() below).
  SCHEMA_ORG_SYNC: Workflow<SchemaOrgSyncParams>;
  RECOMMENDATIONS_SCAN: Workflow<RecommendationsScanParams>;
  EVENT_DATE_DRIFT: Workflow<EventDateDriftParams>;
  /** Inbound email orchestrator. Created from email() entrypoint, one
   *  instance per received message. See workflows/inbound-email.ts. */
  INBOUND_EMAIL: Workflow<InboundEmailParams>;
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
  const sessionId = crypto.randomUUID();
  try {
    const response = env.MAIN_APP
      ? await env.MAIN_APP.fetch(new Request(url, init))
      : await fetch(url, init);
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      await logError(env.DB, {
        source: `mcp:schedule:${label.replace(/\s+/g, "-")}`,
        message: `cron task '${label}' returned non-2xx`,
        statusCode: response.status,
        sessionId,
        context: { path, status: response.status, bodyExcerpt: text },
      });
      return;
    }
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    console.log(`[cron] ${label} ok — ${format(result)}`);
  } catch (error) {
    await logError(env.DB, {
      source: `mcp:schedule:${label.replace(/\s+/g, "-")}`,
      message: `cron task '${label}' threw unhandled exception`,
      error,
      sessionId,
      context: { path },
    });
  }
}

// runScheduledRecommendationsScan was deleted in the Phase 2 Workflows
// migration. The chunked HTTP cursor loop is now durable per-chunk via
// RecommendationsScanWorkflow (mcp-server/src/workflows/recommendations-scan.ts),
// fired from the scheduled() handler below via
// env.RECOMMENDATIONS_SCAN.create({}).

/**
 * Fire a workflow create() from the cron handler. Catches binding/quota
 * failures so a single workflow's create error doesn't break the whole
 * cron Promise.all. The workflow's own internal errors are logged
 * inside the workflow class via logError to mcp:workflow:<name>.
 */
async function createWorkflowOrLog(
  env: Env,
  label: string,
  createFn: () => Promise<{ id: string }>
): Promise<void> {
  try {
    const instance = await createFn();
    console.log(`[cron] workflow '${label}' created — instance ${instance.id}`);
  } catch (error) {
    await logError(env.DB, {
      source: `mcp:schedule:${label}`,
      message: `failed to create workflow instance for cron task '${label}'`,
      error,
    });
  }
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

// runScheduledEventDateDrift was deleted in the Phase 2 Workflows
// migration. The chunked HTTP cursor loop is now durable per-chunk via
// EventDateDriftWorkflow (mcp-server/src/workflows/event-date-drift.ts),
// fired from the scheduled() handler below via
// env.EVENT_DATE_DRIFT.create({}).

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
  const SOURCE = "mcp:schedule:pending-pings-flush";
  const sessionId = crypto.randomUUID();
  try {
    const { getDb } = await import("./db.js");
    const { claimAndFlush } = await import("./pending-pings.js");
    const db = getDb(env.DB);
    const result = await claimAndFlush(db, env, {
      entityType: "all",
      maxAgeSeconds: 3600,
      source: "cron-flush",
    });
    console.log(
      `[cron] pending-pings flush ok — flushed=${result.flushedCount} batch=${result.batchId} indexnow=${result.indexnowResponse}`
    );
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "pending-pings flush threw",
      error,
      sessionId,
    });
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
export { RecommendationsScanWorkflow } from "./workflows/recommendations-scan.js";
export { EventDateDriftWorkflow } from "./workflows/event-date-drift.js";
export { InboundEmailWorkflow } from "./workflows/inbound-email.js";

// ---------------------------------------------------------------------------
// Workflow trigger endpoints (HTTP escape hatch for Pages)
// ---------------------------------------------------------------------------
//
// Pages can't bind workflow classes directly via [[workflows]] in its
// wrangler.toml (see comment in main app's wrangler.toml). So Pages-side
// endpoints that need to start / poll workflows fetch these HTTP routes
// instead. Auth: X-Internal-Key, same pattern used by cron sweeps + email
// handler. Returns null if the path doesn't match — caller falls through
// to the OAuth provider.
async function handleWorkflowEndpoints(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  // X-Internal-Key gate.
  const internalKey = request.headers.get("x-internal-key");
  if (!internalKey || internalKey !== env.INTERNAL_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/admin/workflows/schema-org-sync/start
  if (url.pathname === "/api/admin/workflows/schema-org-sync/start" && request.method === "POST") {
    let body: { eventIds?: unknown; delayMs?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!Array.isArray(body.eventIds) || body.eventIds.length === 0) {
      return jsonResponse({ error: "eventIds required (non-empty array)" }, 400);
    }
    const eventIds = body.eventIds.filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    if (eventIds.length === 0) {
      return jsonResponse({ error: "eventIds contained no valid strings" }, 400);
    }
    const delayMs = typeof body.delayMs === "number" ? body.delayMs : undefined;
    try {
      const instance = await env.SCHEMA_ORG_SYNC.create({
        params: delayMs !== undefined ? { eventIds, delayMs } : { eventIds },
        retention: { successRetention: "7 days", errorRetention: "7 days" },
      });
      return jsonResponse({ workflowId: instance.id, eventCount: eventIds.length });
    } catch (err) {
      await logError(env.DB, {
        source: "mcp:workflows-api",
        message: "Failed to create schema-org-sync workflow instance",
        error: err,
        context: { eventCount: eventIds.length },
      });
      return jsonResponse({ error: "workflow_create_failed" }, 500);
    }
  }

  // GET /api/admin/workflows/schema-org-sync/status/:id
  const statusMatch = url.pathname.match(
    /^\/api\/admin\/workflows\/schema-org-sync\/status\/([A-Za-z0-9_-]+)$/
  );
  if (statusMatch && request.method === "GET") {
    const id = statusMatch[1];
    try {
      const instance = await env.SCHEMA_ORG_SYNC.get(id);
      const state = await instance.status();
      return jsonResponse({ workflowId: id, ...state });
    } catch (err) {
      return jsonResponse(
        {
          error: "workflow_not_found",
          message: err instanceof Error ? err.message : "unknown",
        },
        404
      );
    }
  }

  // GET /api/admin/workflows/inbound-email/status/:id
  // Inbound-email workflows are normally created from the email()
  // entrypoint, not from outside. This route exists for the future
  // admin inbox UI (PR #2) to poll status of a specific inbound message.
  const inboundStatusMatch = url.pathname.match(
    /^\/api\/admin\/workflows\/inbound-email\/status\/([A-Za-z0-9_-]+)$/
  );
  if (inboundStatusMatch && request.method === "GET") {
    const id = inboundStatusMatch[1];
    try {
      const instance = await env.INBOUND_EMAIL.get(id);
      const state = await instance.status();
      return jsonResponse({ workflowId: id, ...state });
    } catch (err) {
      return jsonResponse(
        { error: "workflow_not_found", message: err instanceof Error ? err.message : "unknown" },
        404
      );
    }
  }

  // POST /api/admin/workflows/inbound-email/start
  // Admin "retry this inbound email" trigger. Takes { messageRowId,
  // intent } — the inbound_emails row must already exist (the entrypoint
  // creates it before calling .create() normally). Useful for re-running
  // a workflow that errored out or for testing intent changes.
  if (url.pathname === "/api/admin/workflows/inbound-email/start" && request.method === "POST") {
    let body: { messageRowId?: unknown; intent?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (typeof body.messageRowId !== "string" || body.messageRowId.length === 0) {
      return jsonResponse({ error: "messageRowId required (non-empty string)" }, 400);
    }
    if (typeof body.intent !== "string") {
      return jsonResponse({ error: "intent required" }, 400);
    }
    const validIntents = new Set([
      "submit",
      "correction",
      "support",
      "press",
      "unsubscribe",
      "unknown",
    ]);
    if (!validIntents.has(body.intent)) {
      return jsonResponse({ error: "intent must be one of: " + [...validIntents].join(", ") }, 400);
    }
    try {
      const instance = await env.INBOUND_EMAIL.create({
        params: {
          messageRowId: body.messageRowId,
          intent: body.intent as InboundEmailParams["intent"],
        },
        retention: { successRetention: "7 days", errorRetention: "7 days" },
      });
      return jsonResponse({ workflowId: instance.id, messageRowId: body.messageRowId });
    } catch (err) {
      await logError(env.DB, {
        source: "mcp:workflows-api",
        message: "Failed to create inbound-email workflow instance",
        error: err,
        context: { messageRowId: body.messageRowId, intent: body.intent },
      });
      return jsonResponse({ error: "workflow_create_failed" }, 500);
    }
  }

  // POST /api/admin/workflows/inbound-email/sweep
  // Manually trigger the stale-row sweep for inbound_emails (rows in
  // status='received' AND workflow_instance_id IS NULL older than the
  // sweep's threshold). Useful for immediate recovery without waiting
  // for the next */10 cron firing. Returns the SweepResult with per-row
  // outcomes so admin can confirm exactly what was retried. No body
  // required.
  if (url.pathname === "/api/admin/workflows/inbound-email/sweep" && request.method === "POST") {
    try {
      const db = getDb(env.DB);
      const result = await runInboundEmailStaleSweep(db, env);
      return jsonResponse(result);
    } catch (err) {
      await logError(env.DB, {
        source: "mcp:workflows-api",
        message: "Manual inbound-email stale-sweep threw",
        error: err,
      });
      return jsonResponse({ error: "sweep_failed" }, 500);
    }
  }

  // Unknown sub-path under /api/admin/workflows/ — let it fall through.
  return null;
}

/**
 * Inbound-email admin endpoints — separate from /api/admin/workflows/
 * because they target the inbound_emails row (and its workflow instance
 * transitively), not the workflow binding directly. Currently:
 *   POST /api/admin/inbound-emails/:rowId/decide  — sends the
 *        admin-decision event to the in-flight InboundEmailWorkflow
 *        instance for correction/press intents.
 *
 * Auth: same X-Internal-Key gate as handleWorkflowEndpoints. Pages
 * proxies admin POSTs through to this route via the main app endpoint.
 */
async function handleInboundEmailsApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const internalKey = request.headers.get("x-internal-key");
  if (!internalKey || internalKey !== env.INTERNAL_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/admin/inbound-emails/:rowId/decide
  const decideMatch = url.pathname.match(
    /^\/api\/admin\/inbound-emails\/([A-Za-z0-9_-]+)\/decide$/
  );
  if (decideMatch && request.method === "POST") {
    const rowId = decideMatch[1];
    let body: { action?: unknown; note?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const validActions = new Set(["applied", "rejected", "needs-more-info"]);
    if (typeof body.action !== "string" || !validActions.has(body.action)) {
      return jsonResponse(
        { error: "action must be one of: applied, rejected, needs-more-info" },
        400
      );
    }
    const note =
      typeof body.note === "string" && body.note.length > 0 ? body.note.slice(0, 500) : undefined;

    // Look up workflow_instance_id from the row. We require status='waiting'
    // because the workflow has only one waitForEvent in its run() — sending
    // an event when the instance is past that point silently no-ops, which
    // would be a confusing UX. Reject early instead.
    const db = getDb(env.DB);
    const rows = await db
      .select({
        workflowInstanceId: inboundEmails.workflowInstanceId,
        status: inboundEmails.status,
        intent: inboundEmails.intent,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, rowId))
      .limit(1);
    if (rows.length === 0) {
      return jsonResponse({ error: "row not found" }, 404);
    }
    const { workflowInstanceId, status: rowStatus, intent } = rows[0];
    if (rowStatus !== "waiting") {
      return jsonResponse({ error: `row not awaiting admin decision; status=${rowStatus}` }, 409);
    }
    if (intent !== "correction" && intent !== "press") {
      return jsonResponse(
        { error: `decide endpoint only supports correction/press intents; intent=${intent}` },
        400
      );
    }
    if (!workflowInstanceId) {
      return jsonResponse({ error: "row has no workflow_instance_id" }, 500);
    }

    try {
      const instance = await env.INBOUND_EMAIL.get(workflowInstanceId);
      await instance.sendEvent({
        type: "admin-decision",
        payload: { action: body.action, note },
      });
    } catch (err) {
      await logError(env.DB, {
        source: "mcp:inbound-emails-api",
        message: "Failed to send admin-decision event to workflow",
        error: err,
        context: { rowId, workflowInstanceId, action: body.action },
      });
      return jsonResponse({ error: "send_event_failed" }, 500);
    }

    return jsonResponse({ ok: true, rowId, action: body.action });
  }

  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
    // Unknown queue — log to D1 so it's queryable later (silent acking
    // of an unexpected queue would mask configuration drift).
    await logError(env.DB, {
      level: "warn",
      source: "mcp:queue",
      message: "received batch from unknown queue; acking without action",
      context: { queue: batch.queue, batchSize: batch.messages.length },
    });
    for (const m of batch.messages) m.ack();
  },

  // Inbound email — dispatched by Cloudflare Email Routing rules that
  // target this Worker. Routes are configured in the Email Routing
  // dashboard (or via API), NOT in wrangler.toml. Today only submit@ is
  // wired; the handler validates and routes internally.
  //
  // The handler itself has its own top-level try/catch that logs to
  // error_logs and forwards the raw message to admin Gmail. This outer
  // try/catch is a second line of defense — if the inner one throws
  // (which it shouldn't), we still capture something. Re-throwing
  // surfaces the failure in CF's own metrics.
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await handleInboundEmail(message, env, ctx);
    } catch (err) {
      await logError(env.DB, {
        source: "mcp:email-entrypoint",
        message: "handleInboundEmail re-threw to entrypoint (outer catch)",
        error: err,
        context: { from: message.from, to: message.to, rawSize: message.rawSize },
      }).catch(() => {});
      throw err;
    }
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
      // Two parallel sweeps share this cadence:
      //   - KPI recompute (the original tenant)
      //   - Inbound-email stale-row recovery (added 2026-05-19 after the
      //     da76901e workflow-error incident — rows can land in
      //     status='received' with workflow_instance_id=NULL if D1 was
      //     transient during mark-processing, and without this sweep the
      //     submitter never gets an auto-reply)
      ctx.waitUntil(
        Promise.all([runScheduledKpiRecompute(env), runScheduledInboundEmailStaleSweep(env)]).then(
          () => undefined
        )
      );
      return;
    }
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(runScheduledPendingPingsFlush(env));
      return;
    }
    // Default daily branch (covers "0 6 * * *" and any future daily crons).
    // Two of the sweeps are now Workflows (recommendations-scan,
    // event-date-drift) — we fire them via .create() and the workflow
    // runs durably in the background, surviving Worker restarts and
    // recovering per-chunk failures via step.do retry. The remaining
    // three are single-call sweeps via runMainAppSweep (low score in
    // docs/cloudflare-workflows-audit.md, left as-is).
    ctx.waitUntil(
      Promise.all([
        createWorkflowOrLog(env, "recommendations-scan", () =>
          env.RECOMMENDATIONS_SCAN.create({
            retention: { successRetention: "7 days", errorRetention: "7 days" },
          })
        ),
        runScheduledGscSweep(env),
        runScheduledTimeToIndexSweep(env),
        runScheduledGa4LivenessCheck(env),
        createWorkflowOrLog(env, "event-date-drift", () =>
          env.EVENT_DATE_DRIFT.create({
            retention: { successRetention: "7 days", errorRetention: "7 days" },
          })
        ),
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

    // Internal endpoints — Pages (which can't bind workflows directly per
    // wrangler.toml comment) calls these to start / poll Workflow instances.
    // Auth via X-Internal-Key, matching the existing internal-call pattern
    // used by the cron sweeps + email handler.
    if (url.pathname.startsWith("/api/admin/workflows/")) {
      const response = await handleWorkflowEndpoints(request, env, url);
      if (response) return response;
    }

    if (url.pathname.startsWith("/api/admin/inbound-emails/")) {
      const response = await handleInboundEmailsApi(request, env, url);
      if (response) return response;
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
