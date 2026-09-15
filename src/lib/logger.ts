import { errorLogs } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { describeError } from "@takemetothefair/utils";

interface LogErrorOptions {
  message: string;
  error?: unknown;
  source?: string;
  request?: Request;
  context?: Record<string, unknown>;
  level?: "error" | "warn" | "info";
  statusCode?: number;
  requestId?: string;
  // OPE-80 (drizzle/0147) — queryable route + joinable digest columns. Kept in
  // addition to whatever the caller stashes in `context` so error_logs can be
  // filtered by route and joined on digest across client + server rows.
  route?: string;
  digest?: string;
}

export async function logError(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  options: LogErrorOptions
): Promise<void> {
  const {
    message,
    error,
    source,
    request,
    context,
    level = "error",
    statusCode,
    route,
    digest,
  } = options;

  const stackTrace = error instanceof Error ? error.stack : error ? String(error) : undefined;
  // OPE-1030 — include the cause chain: a Drizzle `Failed query:` wrapper keeps
  // the D1 error only on `.cause`.
  const fullMessage = error instanceof Error ? `${message}: ${describeError(error)}` : message;

  // Always log to console
  console.error(fullMessage, error);

  if (!db) return;

  try {
    await db.insert(errorLogs).values({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      level,
      message: fullMessage,
      context: context ? JSON.stringify(context) : "{}",
      url: request?.url,
      method: request?.method,
      statusCode,
      stackTrace,
      userAgent: request?.headers?.get("user-agent") ?? undefined,
      source,
      route,
      digest,
    });
    // OPE-993 — no pruning here. The 30-day window is enforced by the MCP
    // daily cron (mcp-server/src/log-table-retention.ts), which reports each
    // run; this used to be a 1% dice roll whose failures nothing could see.
  } catch (logErr) {
    // Never throw from the logger
    console.error("Failed to write error log to D1:", logErr);
  }
}
