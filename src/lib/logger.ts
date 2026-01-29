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
  } = options;

  const stackTrace =
    error instanceof Error ? error.stack : error ? String(error) : undefined;
  const fullMessage =
    error instanceof Error ? `${message}: ${error.message}` : message;

  // Always log to console
  console.error(fullMessage, error);

  if (!db) return;

  try {
    await db.insert(errorLogs).values({
      id: crypto.randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
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

    // 1% probabilistic cleanup of old logs
    if (Math.random() < 0.01) {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 2592000;
      await db.delete(errorLogs).where(lt(errorLogs.timestamp, thirtyDaysAgo));
    }
  } catch (logErr) {
    // Never throw from the logger
    console.error("Failed to write error log to D1:", logErr);
  }
}
