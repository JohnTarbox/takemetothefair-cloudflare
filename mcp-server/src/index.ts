import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { getCurrentAgent } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoginHandler } from "./oauth/login-handler.js";
import {
  decideSendRouting,
  sendViaConnection,
  type ConnectionLike,
  type TransportPrivates,
} from "./transport-collision-fix.js";
import { timingSafeEqualString } from "@takemetothefair/utils";
import { getDb } from "./db.js";
import { authenticateToken } from "./auth.js";
import { registerPublicTools } from "./tools/public.js";
import { registerUserTools } from "./tools/user.js";
import { registerVendorTools } from "./tools/vendor.js";
import { registerPromoterTools } from "./tools/promoter.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerAdminProblemReportTools } from "./tools/admin-problem-reports.js";
import { correlateProblemReportCore } from "./problem-reports/correlate.js";
import { registerMergeEntitiesTools } from "./tools/admin-merge-entities.js";
import { registerVendorHierarchyTools } from "./tools/admin-vendor-hierarchy.js";
import { registerSyndicationTools } from "./tools/admin-syndication.js";
import { registerEnrichVendorTool } from "./tools/admin-enrich-vendor.js";
import { registerSendVendorEmailTool } from "./tools/admin-send-vendor-email.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerBlogTools } from "./tools/blog.js";
import { registerContentLinksTools } from "./tools/content-links.js";
import { handleInboundEmail, type ForwardableEmailMessage } from "./email-handler.js";
import {
  runInboundEmailStaleSweep,
  runScheduledInboundEmailStaleSweep,
} from "./inbound-email-stale-sweep.js";
import { runScheduledDedupSweepCanary } from "./dedup-sweep-canary.js";
import { runScheduledCompletenessRecompute } from "./completeness-recompute-canary.js";
import { runScheduledPageErrorCanary } from "./page-error-canary.js";
import { runScheduledStandingFailureCanary } from "./standing-failure-canary.js";
import { runScheduledStalePageRadar } from "./goodwill/stale-page-radar.js";
import { runOccurredTransitionSweep } from "./event-occurred-sweep.js";
import { runScheduledSelfConsistencyCron } from "./goodwill/self-consistency-cron.js";
import { runScheduledGoodwillHealthCanary } from "./goodwill/health-canary.js";
import { runScheduledHoldoutSampling } from "./goodwill/holdout-sampling.js";
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
  // GW1.1 (2026-06-03) — ingest_addverify discrepancy capture. Producer
  // here is used by the /api/admin/internal/enqueue-discrepancy proxy
  // (Pages → MCP HTTP hop); consumer drains and writes via captureDiscrepancy.
  EVENT_DISCREPANCIES?: Queue;
  // SYN1 (2026-06-12) — syndication change triggers. Producer (MCP update_*
  // tools + main-app PATCH routes) and consumer (handleSyndicationBatch) both
  // bound here.
  SYNDICATION_CHANGES?: Queue;
  // I1 (2026-06-13) — vendor-enrichment jobs. Producer (nightly cron selector +
  // enrich_vendor tool) and consumer (handleEnrichmentBatch) both bound here.
  VENDOR_ENRICHMENT?: Queue;
  // I1 — Browser-Rendering REST credentials for the enrichment fetch path.
  // Account id is a [vars] entry; the token is a secret (same value the main
  // app holds). When the token is unset the BR escalation no-ops cleanly.
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RENDERING_TOKEN?: string;
  // I1 — "false" enables Phase-2 auto-merge; anything else (incl. unset) keeps
  // the Phase-1 dry-run-only behavior.
  ENRICHMENT_DRY_RUN?: string;
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
  // A3 / PR-6 (2026-06-01 EVE) — Slack incoming-webhook URL for technical
  // alerts (KPI alerts + dedup-sweep canary). Set via
  // `wrangler secret put SLACK_WEBHOOK_URL_TECHNICAL` on the MCP Worker.
  // Same channel as the main app's SLACK_WEBHOOK_URL_TECHNICAL secret
  // (which feeds src/lib/kpi-alerts.ts); they're independently bound
  // per-artifact per [[feedback_pages_secret_requires_redeploy]]. When
  // unset, the dedup canary no-ops cleanly (logs configuration note,
  // never throws), so local dev / CI without secrets keeps working.
  SLACK_WEBHOOK_URL_TECHNICAL?: string;
  // PR-8 (2026-06-02) — Email alternative to Slack for the dedup-sweep
  // canary. Set to a destination email address via
  // `wrangler secret put ALERT_EMAIL_TECHNICAL` on the MCP Worker. When
  // set, RED/YELLOW canary transitions push to env.EMAIL_JOBS for
  // delivery via the same queue-consumer path that handles every other
  // outbound MCP email. Independent of the Slack webhook — set either,
  // both, or neither.
  ALERT_EMAIL_TECHNICAL?: string;
}

// Re-export for the canary helper, which needs the same Env type.
export type { Env };

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
        // UR1 C5 (2026-06-04) — problem-report triage tools.
        registerAdminProblemReportTools(this.server, db);
        // DQ1 follow-up (2026-06-05) — merge_venue + merge_promoter.
        registerMergeEntitiesTools(this.server, db, auth);
        // EH1 Phase 1 (2026-06-05) — set_vendor_relationship + set_vendor_display_policy + set_vendor_alias.
        registerVendorHierarchyTools(this.server, db, auth);
        // SYN1 (2026-06-12) — syndication subscriber registry tools.
        registerSyndicationTools(this.server, db, auth);
        // I1 (2026-06-13) — synchronous one-off vendor enrichment trigger.
        registerEnrichVendorTool(this.server, db, auth, this.env);
        // K31 (2026-06-21) — send_vendor_email (claim invites + outreach).
        registerSendVendorEmailTool(this.server, db, auth, this.env);
        groups.admin = diff(before);

        before = snapshot();
        registerAnalyticsTools(this.server, auth, this.env);
        groups.analytics = diff(before);

        before = snapshot();
        registerBlogTools(this.server, db, auth, this.env);
        groups.blog = diff(before);

        before = snapshot();
        registerContentLinksTools(this.server, db, auth, this.env);
        groups.contentLinks = diff(before);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Routing fix for upstream MCP TS SDK #1186 (open) / our issue #121:
  // "Zombie Task Collision in StreamableHTTPServerTransport"
  //
  // The agents package's StreamableHTTPServerTransport.send() routes responses
  // by walking agent.getConnections() and picking the first connection whose
  // state.requestIds includes the response's request id. When two concurrent
  // clients (or one client reusing JSON-RPC ids across parallel requests) end
  // up with the same id in their per-connection state, find() returns either
  // connection arbitrarily. Result: the response is written to the wrong
  // client's HTTP socket — silently, with the wrong shape.
  //
  // Production manifestations:
  //   - 2026-05-10: 8 parallel update_event MCP calls, 3 returned
  //     page_analytics-shaped responses.
  //   - 2026-05-24 (analyst report): update_blog_post / get_blog_links_in_post
  //     during a bulk blog-linking session, several echoed an unrelated
  //     post or event payload. Writes landed correctly; responses didn't.
  //
  // What this wrap does:
  //   1. Hook transport.onmessage to record (requestId -> connection.id) at
  //      intake. The agents transport sets connection.state.requestIds in
  //      handlePostRequest before calling onmessage, so by intake time the
  //      async-context connection from getCurrentAgent() is the originating
  //      connection.
  //   2. Replace transport.send with a router that:
  //        - passes through to original when no collision (≤1 match);
  //        - direct-writes to the tracked connection on a fixable collision,
  //          bypassing the buggy find();
  //        - throws a structured error when collision is unfixable (intake
  //          record missing), surfacing as a JSON-RPC error to the caller
  //          rather than a silent wrong-shape response.
  //
  // Removable when: agents package upgrades past the upstream SDK fix for
  // #1186, OR the agents transport switches to composite (streamId,
  // requestId) keys. The pure routing logic and direct-write helper live in
  // ./transport-collision-fix.ts and are unit-tested there.
  async onStart(props?: UserProps) {
    await super.onStart(props);
    const transport = (this as unknown as { _transport?: unknown })._transport as
      | (TransportPrivates & {
          send?: (m: unknown, o?: { relatedRequestId?: unknown }) => Promise<unknown>;
          onmessage?: (m: unknown, extra: unknown) => unknown;
        })
      | undefined;
    if (!transport || typeof transport.send !== "function") return;

    // Per-DO map of intake-recorded (requestId -> Set<connection.id>).
    //
    // K19 (2026-06-07): upgraded from `Map<unknown, string>` to a multi-
    // valued set so two concurrent intakes that share a JSON-RPC id no
    // longer clobber each other. The original wrap correctly handled the
    // single-collision case at send time, but `intakeConnByReqId.set(id,
    // connId)` overwrote on key collision — so when subagent B's intake
    // arrived after A's with id=1, A's tracking was lost, A's send picked
    // up B's connection id from the map, and A's response was routed to
    // B's socket. The test file explicitly documented this gap at
    // transport-collision-fix.test.ts:213-251 but didn't fix it.
    //
    // We remove a specific connection.id from its set at send time once
    // we know which connection that response was for (via the routing
    // decision). If the set goes empty, the key is dropped. Memory is
    // bounded by concurrent in-flight count, same as the single-valued
    // version was.
    const intakeConnByReqId = new Map<unknown, Set<string>>();

    // Hook onmessage to record the originating connection at intake time.
    // Defense in depth: any throw inside the recording branch is caught so
    // a tracking failure can never block message intake.
    const originalOnMessage = transport.onmessage;
    if (typeof originalOnMessage === "function") {
      const boundOnMessage = originalOnMessage.bind(transport);
      transport.onmessage = (m: unknown, extra: unknown) => {
        try {
          const message = m as { id?: unknown };
          if (message && message.id !== undefined && message.id !== null) {
            const { connection } = getCurrentAgent();
            if (connection?.id) {
              let set = intakeConnByReqId.get(message.id);
              if (!set) {
                set = new Set<string>();
                intakeConnByReqId.set(message.id, set);
              }
              set.add(connection.id);
            }
          }
        } catch {
          /* never block intake on tracking failure */
        }
        return boundOnMessage(m, extra);
      };
    }

    const originalSend = transport.send.bind(transport);
    const getConnsArr = (): ConnectionLike[] =>
      Array.from(this.getConnections() ?? []) as ConnectionLike[];

    // Remove a single connection.id from the intake set for `reqId`,
    // dropping the key when the set is exhausted. No-op if reqId is
    // nullish or the set is missing. Called from each routing branch
    // with the connection.id we actually routed to (or attempted to);
    // the surviving entries belong to other concurrent in-flight calls.
    const consumeIntake = (reqId: unknown, connectionId: string | undefined): void => {
      if (reqId === undefined || reqId === null) return;
      const set = intakeConnByReqId.get(reqId);
      if (!set) return;
      if (connectionId) set.delete(connectionId);
      // Clear the key if exhausted, OR if we couldn't identify the
      // connection (no connectionId) — that branch falls back to the
      // pre-K19 behavior of dropping the key, preventing an unbounded
      // leak when both signals are unavailable.
      if (!connectionId || set.size === 0) {
        intakeConnByReqId.delete(reqId);
      }
    };

    transport.send = async (m: unknown, o?: { relatedRequestId?: unknown }) => {
      const message = m as { id?: unknown };
      const reqId = o?.relatedRequestId ?? message?.id;

      const intakeConnectionIds =
        reqId !== undefined && reqId !== null ? intakeConnByReqId.get(reqId) : undefined;

      // K19: read the send-time async-context connection as the strongest
      // disambiguating signal. When ALS propagates from intake → tool
      // callback → send (the common case), this uniquely identifies the
      // originating connection regardless of how many concurrent intakes
      // collided on the same id. Wrapped in try/catch because some SDK
      // paths historically broke ALS, in which case we fall back to the
      // intake set.
      let sendTimeConnectionId: string | undefined;
      try {
        sendTimeConnectionId = getCurrentAgent().connection?.id;
      } catch {
        /* ALS unavailable — rely on intake set */
      }

      const decision = decideSendRouting(getConnsArr(), reqId, {
        sendTimeConnectionId,
        intakeConnectionIds,
      });

      if (decision.kind === "passthrough") {
        consumeIntake(reqId, decision.matched?.id ?? sendTimeConnectionId);
        return originalSend(m, o);
      }

      if (decision.kind === "ambiguous") {
        // Broken request — drop the entire key so subsequent calls aren't
        // poisoned by stale intake entries from the failed batch.
        if (reqId !== undefined && reqId !== null) intakeConnByReqId.delete(reqId);
        console.error(
          `[MCP/#121] response routing ambiguous for request id ${String(reqId)} — refusing send to prevent wrong-shape response. Matching connections: ${decision.matchedIds.join(", ")}; sendTimeConn=${sendTimeConnectionId ?? "none"}; intakeConns=${intakeConnectionIds ? Array.from(intakeConnectionIds).join(",") : "none"}`
        );
        throw new Error(
          `MCP response routing ambiguous for request id ${String(reqId)}; ${decision.matchedIds.length} connections collide and no send-time signal disambiguates. Caller should re-fetch the underlying record.`
        );
      }

      // decision.kind === "fixed" — direct-write to the correct connection.
      consumeIntake(reqId, decision.connection.id);
      console.warn(
        `[MCP/#121] collision routed to connection ${decision.connection.id} via ${decision.via} for request id ${String(reqId)} (bypassed buggy find())`
      );
      await sendViaConnection(transport, decision.connection, m, reqId);
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
      registerAdminProblemReportTools(server, db);
      registerMergeEntitiesTools(server, db, auth);
      registerVendorHierarchyTools(server, db, auth);
      registerEnrichVendorTool(server, db, auth, env);
      registerSendVendorEmailTool(server, db, auth, env);
      registerAnalyticsTools(server, auth, env);
      registerBlogTools(server, db, auth, env);
      registerContentLinksTools(server, db, auth, env);
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
  if (!(await timingSafeEqualString(internalKey, env.INTERNAL_API_KEY))) {
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
  if (!(await timingSafeEqualString(internalKey, env.INTERNAL_API_KEY))) {
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

/**
 * Internal RPC-style endpoints called by the Pages app via HTTPS +
 * X-Internal-Key. Why this exists: Cloudflare Pages does not wire the
 * `[[queues.producers]]` block from wrangler.toml to the runtime queue
 * registry (the `deployment_configs.queue_producers` field populates,
 * but the queue's actual producer list stays empty). The MCP Worker
 * DOES have a working producer binding for EMAIL_JOBS, so Pages calls
 * here and we send the message on its behalf. Adds ~50-100ms HTTP hop
 * compared to a direct queue.send, but the actual SMTP/CF Email Sending
 * step is async anyway so user-visible flows are unaffected.
 *
 * Auth: same X-Internal-Key gate as the other handle*Api helpers.
 */
async function handleInternalApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const internalKey = request.headers.get("x-internal-key");
  if (!(await timingSafeEqualString(internalKey, env.INTERNAL_API_KEY))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/admin/internal/enqueue-email — proxy for Pages' enqueueEmail().
  if (url.pathname === "/api/admin/internal/enqueue-email" && request.method === "POST") {
    if (!env.EMAIL_JOBS) {
      // Should never happen in production — the MCP wrangler.toml has the
      // binding. Defensive return so a misconfigured env doesn't silently
      // drop messages.
      await logError(env.DB, {
        level: "warn",
        source: "mcp:internal-api",
        message: "EMAIL_JOBS binding missing on MCP Worker; cannot proxy enqueue",
      });
      return jsonResponse({ error: "email_jobs_binding_missing" }, 500);
    }

    let body: {
      to?: unknown;
      subject?: unknown;
      html?: unknown;
      text?: unknown;
      from?: unknown;
      source?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    // Required fields: to, subject, html, text. `from` and `source` are
    // optional (source defaults to a hint string so the stub-fallback
    // sweep can still attribute Pages-originated calls).
    if (
      typeof body.to !== "string" ||
      typeof body.subject !== "string" ||
      typeof body.html !== "string" ||
      typeof body.text !== "string"
    ) {
      return jsonResponse(
        { error: "missing_required_fields", required: ["to", "subject", "html", "text"] },
        400
      );
    }
    const from = typeof body.from === "string" ? body.from : undefined;
    const source = typeof body.source === "string" ? body.source : "pages-proxy";

    try {
      await env.EMAIL_JOBS.send({
        to: body.to,
        subject: body.subject,
        html: body.html,
        text: body.text,
        from,
        source,
      });
    } catch (e) {
      await logError(env.DB, {
        source: "mcp:internal-api",
        message: "EMAIL_JOBS.send threw in enqueue-email proxy",
        error: e,
        context: { to: body.to, subject: body.subject, source },
      });
      return jsonResponse({ error: "queue_send_failed" }, 502);
    }

    return jsonResponse({ ok: true });
  }

  // GW1.1 (2026-06-03). POST /api/admin/internal/enqueue-discrepancy —
  // proxy for Pages' enqueueIngestDiscrepancy(). Same shape as the
  // enqueue-email proxy above. Pages's [[queues.producers]] binding for
  // EVENT_DISCREPANCIES no-ops at runtime, so the main-app producer
  // falls through to this endpoint, and we send the message on its
  // behalf via the MCP Worker's working producer binding.
  if (url.pathname === "/api/admin/internal/enqueue-discrepancy" && request.method === "POST") {
    if (!env.EVENT_DISCREPANCIES) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:internal-api",
        message: "EVENT_DISCREPANCIES binding missing on MCP Worker; cannot proxy enqueue",
      });
      return jsonResponse({ error: "event_discrepancies_binding_missing" }, 500);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    // Required string fields: eventId, fieldClass, detectedBy, notes.
    // Numeric: confidence. The *_value, *_source_key, *_source_url
    // halves are nullable per the table schema, so we accept null/
    // undefined and let the consumer pass through. Validation here is
    // shape-defensive — a single bad-shape message shouldn't be DLQ'd
    // for content-validation reasons we could catch upstream.
    if (
      typeof body.eventId !== "string" ||
      typeof body.fieldClass !== "string" ||
      typeof body.detectedBy !== "string" ||
      typeof body.notes !== "string" ||
      typeof body.confidence !== "number"
    ) {
      return jsonResponse(
        {
          error: "missing_required_fields",
          required: ["eventId", "fieldClass", "detectedBy", "notes", "confidence"],
        },
        400
      );
    }

    try {
      await env.EVENT_DISCREPANCIES.send(body);
    } catch (e) {
      await logError(env.DB, {
        source: "mcp:internal-api",
        message: "EVENT_DISCREPANCIES.send threw in enqueue-discrepancy proxy",
        error: e,
        context: { eventId: body.eventId, fieldClass: body.fieldClass },
      });
      return jsonResponse({ error: "queue_send_failed" }, 502);
    }

    return jsonResponse({ ok: true });
  }

  // D (Dev backlog 2026-06-05). POST /api/admin/internal/correlate-problem-report
  // — invoked by the main-app web-form route
  // (src/app/api/report-problem/route.ts) right after its insert, so a
  // user reporting a broken page during an error_logs burst gets the
  // severity bumped to HIGH within ~10s of submit. Shares
  // correlateProblemReportCore with the operator-side MCP tool
  // `correlate_problem_report` so the severity logic has a single audit.
  if (
    url.pathname === "/api/admin/internal/correlate-problem-report" &&
    request.method === "POST"
  ) {
    let body: { id?: unknown; bumpSeverity?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (typeof body.id !== "string" || body.id.length === 0) {
      return jsonResponse({ error: "missing_id" }, 400);
    }
    const bumpSeverity = typeof body.bumpSeverity === "boolean" ? body.bumpSeverity : true;

    try {
      const result = await correlateProblemReportCore(getDb(env.DB), body.id, { bumpSeverity });
      if (!result) {
        return jsonResponse({ error: "not_found", id: body.id }, 404);
      }
      return jsonResponse({ ok: true, result });
    } catch (e) {
      await logError(env.DB, {
        source: "mcp:internal-api",
        message: "correlateProblemReportCore threw in correlate-problem-report endpoint",
        error: e,
        context: { id: body.id, bumpSeverity },
      });
      return jsonResponse({ error: "correlation_failed" }, 502);
    }
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
import {
  handleEmailBatch,
  handleIndexNowBatch,
  handleDiscrepancyBatch,
} from "./queue-consumers.js";
import { handleSyndicationBatch } from "./syndication/dispatch.js";
import type { SyndicationChangeMessage } from "@takemetothefair/utils";
import { handleEnrichmentBatch, type VendorEnrichmentMessage } from "./enrichment/dispatch.js";
import { runScheduledVendorEnrichment } from "./enrichment/select-candidates.js";

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
    if (batch.queue === "event-discrepancies") {
      // GW1.1 (2026-06-03) — ingest_addverify discrepancy capture queue.
      // Producer is Pages's check-duplicate route (proxied through
      // /api/admin/internal/enqueue-discrepancy above).
      await handleDiscrepancyBatch(
        // The handler types its own message shape; cast bridges the
        // generic MessageBatch<unknown>.
        batch as MessageBatch<
          Parameters<typeof handleDiscrepancyBatch>[0]["messages"][number]["body"]
        >,
        env
      );
      return;
    }
    if (batch.queue === "syndication-changes") {
      // SYN1 (2026-06-12) — drain syndication triggers, fan out HMAC-signed
      // webhooks to subscribers. The handler retries/acks per message.
      await handleSyndicationBatch(batch as MessageBatch<SyndicationChangeMessage>, env);
      return;
    }
    if (batch.queue === "vendor-enrichment") {
      // I1 (2026-06-13) — render each vendor's site via Browser Rendering,
      // extract fill-empty-only contact fields, stage proposals (dry-run) or
      // auto-merge un-flagged fills (Phase 2). Per-message ack/retry.
      await handleEnrichmentBatch(batch as MessageBatch<VendorEnrichmentMessage>, env);
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
    //   - "10 6 * * *"    → GW1.3 holdout-sampling (added 2026-06-03)
    //   - "*/10 * * * *"  → §6.3 KPI state-machine recompute (light)
    //   - "0 * * * *"     → hourly: drain pending_search_pings older than 1h
    console.warn(
      `[cron] firing for cron='${controller.cron}' at ${new Date(controller.scheduledTime).toISOString()}`
    );
    if (controller.cron === "10 6 * * *") {
      // GW1.3 holdout-sampling cron — daily ~1% random sample of
      // high-trust source events re-checked against the live source
      // page. 10 minutes after the 06:00 batch so the heavy recs +
      // workflow inits aren't contending for D1 + AI throughput when
      // this fires. See src/goodwill/holdout-sampling.ts for the
      // cap rationale and per-event budget. Pass env directly so the
      // helper can call submitFetch/submitExtract via env.MAIN_APP_URL
      // + env.INTERNAL_API_KEY.
      ctx.waitUntil(
        runScheduledHoldoutSampling(getDb(env.DB), {
          DB: env.DB,
          MAIN_APP_URL: env.MAIN_APP_URL,
          INTERNAL_API_KEY: env.INTERNAL_API_KEY,
        }).then(() => undefined)
      );
      return;
    }
    if (controller.cron === "*/10 * * * *") {
      // Two parallel sweeps share this cadence:
      //   - KPI recompute (the original tenant)
      //   - Inbound-email stale-row recovery (added 2026-05-19 after the
      //     da76901e workflow-error incident — rows can land in
      //     status='received' with workflow_instance_id=NULL if D1 was
      //     transient during mark-processing, and without this sweep the
      //     submitter never gets an auto-reply)
      // Issue #326 (2026-06-04) — page-error canary joins this cron
      // tenant. ~1 COUNT query + 1 small SELECT + (rarely) 1 UPSERT;
      // adds negligible load to the */10 fire. See page-error-canary.ts
      // for thresholds, debounce, and scope rationale.
      ctx.waitUntil(
        Promise.all([
          runScheduledKpiRecompute(env),
          runScheduledInboundEmailStaleSweep(env),
          runScheduledPageErrorCanary(env),
        ]).then(() => undefined)
      );
      return;
    }
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(runScheduledPendingPingsFlush(env));
      return;
    }
    if (controller.cron === "0 7 * * *") {
      // I1 (2026-06-13) — nightly vendor-enrichment sweep. Selects ≤100
      // population-1 vendors and enqueues one job each; the queue consumer does
      // the Browser-Rendering fetch + extract + stage. dry-run by default.
      const jobRunId = `cron-${new Date(controller.scheduledTime).toISOString().slice(0, 10)}-${crypto
        .randomUUID()
        .slice(0, 8)}`;
      ctx.waitUntil(runScheduledVendorEnrichment(env, jobRunId, controller.scheduledTime));
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
        // A3 / PR-6 (2026-06-01 EVE) — daily Slack canary for dedup sweep
        // cluster count growth. Polls /api/admin/duplicates/sweep, snapshots
        // dedup_sweep_snapshots, alerts on RED (+1 day-over-day, always) or
        // YELLOW (>10% vs 7-day avg, 72h-debounced).
        //
        // B — DQ1 (2026-06-06) — venue + promoter parity. Runs the same
        // canary three times (events / venues / promoters), each writing
        // its own (snapshot_date, surface) row to dedup_sweep_snapshots
        // and producing its own RED/YELLOW dispatch with surface name in
        // the subject. Sequential within one Worker invocation — cheaper
        // than three separate cron registrations and the three sweeps
        // share the same internal-key auth round-trip cost.
        runScheduledDedupSweepCanary(env, "events"),
        runScheduledDedupSweepCanary(env, "venues"),
        runScheduledDedupSweepCanary(env, "promoters"),
        // GW1b (analyst, 2026-06-02) — Goodwill Engine Phase 1 capture
        // hooks. Both consume the foundations from GW1a (drizzle/0101)
        // and emit event_discrepancies rows for GW1c/d/e to score and
        // rank. Cosmetic-failsoft per
        // [[feedback_workflow_cosmetic_steps_failsoft]] — each helper
        // catches its own errors and returns a result struct so a
        // single bad row doesn't pull down the sibling crons. Pass the
        // wrapped Db directly per [[feedback_drizzle_d1_unit_test_inject_db]].
        runScheduledStalePageRadar(getDb(env.DB)).then(() => undefined),
        runScheduledSelfConsistencyCron(getDb(env.DB)).then(() => undefined),
        // GW1e (2026-06-02) — daily goodwill-health canary mirrors the
        // dedup-sweep-canary pattern from PR #306. Writes the snapshot,
        // dispatches RED on +1 open growth day-over-day, YELLOW on
        // >10% weighted-priority growth (72h-debounced).
        runScheduledGoodwillHealthCanary(getDb(env.DB), {
          slackWebhookUrl: env.SLACK_WEBHOOK_URL_TECHNICAL ?? null,
          alertEmail: env.ALERT_EMAIL_TECHNICAL ?? null,
          emailQueue: env.EMAIL_JOBS ?? null,
        }).then(() => undefined),
        // D — DQ3 safety-net (2026-06-06) — daily recompute of
        // completeness_score for rows touched in the last 24h. Catches
        // cache rot from ad-hoc D1 bulk-enrichment writes that bypass
        // recompute*Completeness. Cosmetic-failsoft: any per-row error
        // is swallowed inside the helper; the cron always resolves.
        runScheduledCompletenessRecompute(getDb(env.DB)).then(() => undefined),
        // A5 (2026-06-08, REL3 sibling) — standing-failure detector.
        // Catches "same error_logs.source recurring across ≥3 distinct
        // days in 7-day window" — the persistence signal the page-error
        // canary's 10-min rate window misses. REL3 itself ran silently
        // for 3 weeks because of this exact gap. See
        // mcp-server/src/standing-failure-canary.ts. Cosmetic-failsoft
        // by construction (the helper catches its own errors and only
        // logs).
        runScheduledStandingFailureCanary(env),
        // K27 (2026-06-15) — daily OCCURRED auto-transition + recurring-event
        // rollover. Pass 1 flips past-end APPROVED events SCHEDULED→OCCURRED
        // (the transition that had no cron before K27) and rolls FREQ=YEARLY
        // events into next year's TENTATIVE edition; Pass 2 backfills rolls for
        // already-OCCURRED recurring events. Cosmetic-failsoft by construction
        // (each row + each pass catches its own errors and logs to error_logs).
        runOccurredTransitionSweep(getDb(env.DB)).then(() => undefined),
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

    if (url.pathname.startsWith("/api/admin/internal/")) {
      const response = await handleInternalApi(request, env, url);
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
