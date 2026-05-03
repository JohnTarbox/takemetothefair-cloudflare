import { errorLogs } from "@/lib/db/schema";
import { lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

interface LogErrorOptions {
  message: string;
  error?: unknown;
  source?: string;
  request?: Request;
  context?: Record<string, unknown>;
  level?: "error" | "warn" | "info";
  statusCode?: number;
  requestId?: string;
}

export async function logError(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  options: LogErrorOptions
): Promise<void> {
  const { message, error, source, request, context, level = "error", statusCode } = options;

  const stackTrace = error instanceof Error ? error.stack : error ? String(error) : undefined;
  const fullMessage = error instanceof Error ? `${message}: ${error.message}` : message;

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
    });

    // 1% probabilistic cleanup of old logs. If the cleanup itself fails
    // (D1 transient error, lock contention) the surrounding catch would
    // swallow it silently, letting `errorLogs` grow unbounded. Wrap the
    // cleanup so the failure surfaces in `wrangler tail` separately
    // from the original log-write attempt.
    if (Math.random() < 0.01) {
      const thirtyDaysAgo = new Date(Date.now() - 2592000 * 1000);
      try {
        await db.delete(errorLogs).where(lt(errorLogs.timestamp, thirtyDaysAgo));
      } catch (cleanupErr) {
        console.error("[logger] errorLogs cleanup failed:", cleanupErr);
      }
    }
  } catch (logErr) {
    // Never throw from the logger
    console.error("Failed to write error log to D1:", logErr);
  }
}
