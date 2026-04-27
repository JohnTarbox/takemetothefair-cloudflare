import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const MAX_BODY_BYTES = 16_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_STACK_CHARS = 8_000;
const MAX_URL_CHARS = 2_000;

type ClientErrorPayload = {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  errorType?: unknown;
  statusCode?: unknown;
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

  let pathname: string | undefined;
  if (url) {
    try {
      pathname = new URL(url).pathname;
    } catch {
      // Non-absolute URL; leave pathname undefined
    }
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
    context: { errorType, pathname, reportedUrl: url, reportedStatusCode: statusCode },
  });

  return new NextResponse(null, { status: 204 });
}
