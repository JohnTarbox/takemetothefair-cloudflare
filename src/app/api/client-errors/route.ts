export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { isKnownClientNoise, isThirdPartyInjectedError } from "@/lib/client-error-filter";
import { computeSignature } from "@/lib/faults/signature";
import { isDuplicateClientError, type DedupKv } from "@/lib/client-error-ingest-dedup";

const MAX_BODY_BYTES = 16_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_STACK_CHARS = 8_000;
const MAX_URL_CHARS = 2_000;
// OPE-25 — React error-boundary extras.
const MAX_COMPONENT_STACK_CHARS = 8_000;
const MAX_DIGEST_CHARS = 256;

type ClientErrorPayload = {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  errorType?: unknown;
  // OPE-614 — adjudication fields. See the context block below for why.
  userAgent?: unknown;
  reasonType?: unknown;
  reasonConstructor?: unknown;
  filename?: unknown;
  statusCode?: unknown;
  // OPE-25 — sent by the React error boundaries (optional).
  componentStack?: unknown;
  digest?: unknown;
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

export async function POST(request: Request) {
  const rateLimitResult = await checkRateLimit(request, "client-errors");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Invalid content-type" }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 400 });
  }

  let payload: ClientErrorPayload;
  try {
    payload = (await request.json()) as ClientErrorPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawMessage = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!rawMessage) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const message = truncate(rawMessage, MAX_MESSAGE_CHARS);
  const stack =
    typeof payload.stack === "string" && payload.stack.length > 0
      ? truncate(payload.stack, MAX_STACK_CHARS)
      : undefined;
  const url =
    typeof payload.url === "string" && payload.url.length > 0
      ? truncate(payload.url, MAX_URL_CHARS)
      : undefined;
  const errorType = typeof payload.errorType === "string" ? payload.errorType : "unknown";
  const statusCode =
    typeof payload.statusCode === "number" && Number.isFinite(payload.statusCode)
      ? payload.statusCode
      : undefined;
  // OPE-25 — React error-boundary extras (optional). componentStack lands in
  // context so a boundary that can supply it (Next.js App Router boundaries
  // currently cannot) is persisted without further endpoint changes.
  const componentStack =
    typeof payload.componentStack === "string" && payload.componentStack.length > 0
      ? truncate(payload.componentStack, MAX_COMPONENT_STACK_CHARS)
      : undefined;
  const digest =
    typeof payload.digest === "string" && payload.digest.length > 0
      ? truncate(payload.digest, MAX_DIGEST_CHARS)
      : undefined;

  let pathname: string | undefined;
  if (url) {
    try {
      pathname = new URL(url).pathname;
    } catch {
      // Non-absolute URL; leave pathname undefined
    }
  }

  // Drop React streaming/hydration noise before it reaches error_logs.
  // See src/lib/client-error-filter.ts for the rationale and what
  // exactly is filtered. Return 204 so the client doesn't retry.
  if (isKnownClientNoise(stack)) {
    return new NextResponse(null, { status: 204 });
  }

  // OPE-106 — collapse identical bursts from ONE client (a reload-loop
  // unhandledrejection can fire the same error dozens of times in seconds, which
  // the client-side deduper misses across reloads). Dedup on the SAME normalized
  // signature the render-fault reconcile groups on, keyed per client IP, in KV for
  // a short window, so error_logs stays a faithful per-occurrence stream and the
  // fault ledger's count isn't inflated. Fail-open — never suppress on KV error.
  const signature = computeSignature({ route: pathname ?? null, message, digest: digest ?? null });
  const clientIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
  let dedupKv: DedupKv | null = null;
  try {
    dedupKv = (getCloudflareContext().env as { RATE_LIMIT_KV?: DedupKv }).RATE_LIMIT_KV ?? null;
  } catch {
    dedupKv = null;
  }
  if (await isDuplicateClientError(dedupKv, clientIp, signature)) {
    return new NextResponse(null, { status: 204 });
  }

  const db = getCloudflareDb();
  await logError(db, {
    level: "error",
    source: "client",
    message,
    // logError derives stackTrace via String(error); passing the stack string as-is preserves it
    error: stack,
    statusCode,
    request,
    // OPE-80 — also populate the queryable route + digest columns (in ADDITION
    // to keeping them in the context JSON) so client rows are filterable by
    // route and joinable on digest against the server-render rows.
    route: pathname,
    digest,
    context: {
      errorType,
      pathname,
      reportedUrl: url,
      reportedStatusCode: statusCode,
      componentStack,
      digest,
      // OPE-301 — label-only. True when no frame names a source location,
      // which means the throwing code wasn't served by us (extension /
      // in-app-browser injection / eval). We still log the row in full; this
      // just makes such a crash attributable instead of being triaged as a
      // site defect. Nothing downstream is suppressed on it — whether the
      // fault-proposal rail should skip these is the operator's call.
      thirdParty: isThirdPartyInjectedError(stack) || undefined,
      // OPE-614 — capture for ADJUDICATION, not new dedup dimensions.
      //
      // The standing triage precedent was that every client candidate resolves
      // to third-party noise. The payload recorded nothing that could confirm
      // or refute that: `thirdParty` was set on 10 of 450 rows, `stack_trace`
      // was NULL on the whole family under investigation, and there was no
      // `userAgent` field at all. So the precedent was UN-FALSIFIABLE, and it
      // was steering live rulings — manufactured confidence, wrong in the
      // false-healthy direction.
      //
      // `userAgent` is the cheapest discriminator: extension-injected faults
      // concentrate in identifiable browser populations, ours spread across the
      // whole user base — one query separates the hypotheses.
      //
      // ⚠️ Scope 4: NONE of these enter the signature key. `computeSignature`
      // takes route + normalized message only, so dedup is unchanged and a
      // UA-varying fault does not fragment into a row per browser.
      //
      // PII boundary, deliberate and narrow: userAgent only. No IP, no user id.
      userAgent:
        typeof payload.userAgent === "string" ? payload.userAgent.slice(0, 400) : undefined,
      reasonType: typeof payload.reasonType === "string" ? payload.reasonType : undefined,
      reasonConstructor:
        typeof payload.reasonConstructor === "string" ? payload.reasonConstructor : undefined,
      filename: typeof payload.filename === "string" ? payload.filename.slice(0, 500) : undefined,
    },
  });

  return new NextResponse(null, { status: 204 });
}
