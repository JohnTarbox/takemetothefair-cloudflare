/**
 * MCP-side error logger — writes to the same `error_logs` D1 table the
 * main app uses (and that the existing `/admin/logs` UI already filters
 * and searches). Patterned after `src/lib/logger.ts` in the main app,
 * trimmed for the MCP Worker's call sites:
 *
 *   - No `request: Request` parameter — queue / scheduled / email
 *     handlers run outside an HTTP context.
 *   - Adds `sessionId` so all log lines from one inbound email (or one
 *     cron run, one workflow execution) tie together. Filterable via
 *     the existing admin-logs search box.
 *   - Skips the 1% probabilistic cleanup — the main app's higher write
 *     volume already maintains the table.
 *   - Source naming convention: `mcp:<area>[:<sub>]`. Examples in use:
 *       `mcp:email-handler`       — inbound email pipeline
 *       `mcp:email-queue`         — EMAIL_JOBS consumer
 *       `mcp:indexnow`            — IndexNow consumer + helpers
 *       `mcp:schedule:<cron>`     — cron task wrappers
 *       `mcp:workflow:<name>`     — Cloudflare Workflows
 *       `mcp:oauth`               — login handler error paths
 *
 * Never throws. If the D1 write itself fails, the failure is `console.error`'d
 * and the call returns normally so the caller's failure path proceeds
 * uninterrupted. Logging is best-effort by design.
 */

import { errorLogs } from "./schema.js";
import { getDb, type Db } from "./db.js";

export interface LogErrorOptions {
  /** Short, human-readable summary. Prefixed onto the error message if `error` is set. */
  message: string;
  /** The thrown value, if any. `Error.stack` is captured into `stackTrace`. */
  error?: unknown;
  /** Source tag — convention is `mcp:<area>[:<sub>]`. See module doc. */
  source?: string;
  /** Structured details. JSON-stringified into the `context` column. */
  context?: Record<string, unknown>;
  /** "error" | "warn" | "info". Defaults to "error". */
  level?: "error" | "warn" | "info";
  /** HTTP status if relevant to the failure (e.g., upstream API responded 5xx). */
  statusCode?: number;
  /**
   * Stamped into `context.sessionId`. For inbound email: a UUID generated
   * once per message. For cron: a UUID per cron firing. Lets an admin
   * reconstruct a single unit of work's full timeline by searching the
   * UUID substring in `/admin/logs`.
   */
  sessionId?: string;
}

/**
 * Write a row to the `error_logs` D1 table, mirroring the shape the
 * main app's logger produces.
 *
 * @param dbOrD1  Either the raw D1Database binding (will be wrapped with
 *                Drizzle internally) or an already-wrapped Db. Callers
 *                that already hold `getDb(env.DB)` can pass it through;
 *                callers that only have `env.DB` can pass that.
 * @param options Log payload. See `LogErrorOptions`.
 */
export async function logError(
  dbOrD1: Db | D1Database | null | undefined,
  options: LogErrorOptions
): Promise<void> {
  const { message, error, source, context, level = "error", statusCode, sessionId } = options;

  const stackTrace =
    error instanceof Error ? error.stack : error !== undefined ? String(error) : undefined;
  const fullMessage =
    error instanceof Error
      ? `${message}: ${error.message}`
      : error !== undefined
        ? `${message}: ${String(error)}`
        : message;

  // Always log to console too — gives wrangler tail visibility for live
  // debugging even when D1 is unreachable.
  if (level === "error") console.error(fullMessage, error ?? "");
  else if (level === "warn") console.warn(fullMessage);
  else console.log(fullMessage);

  if (!dbOrD1) return;

  // Merge sessionId into context so it's visible in the same JSON blob
  // that `/admin/logs` shows on expand — no schema change required.
  const fullContext = sessionId ? { ...(context ?? {}), sessionId } : context;

  let db: Db;
  try {
    // Heuristic: if the input has `.insert` (Drizzle), treat as Db. Otherwise
    // wrap with getDb. Avoids a separate overload signature.
    db =
      typeof (dbOrD1 as { insert?: unknown }).insert === "function"
        ? (dbOrD1 as Db)
        : getDb(dbOrD1 as D1Database);
  } catch (wrapErr) {
    console.error("[mcp:logger] failed to wrap D1 binding:", wrapErr);
    return;
  }

  try {
    await db.insert(errorLogs).values({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      level,
      message: fullMessage,
      context: fullContext ? JSON.stringify(fullContext) : "{}",
      url: undefined,
      method: undefined,
      statusCode,
      stackTrace,
      userAgent: undefined,
      source,
    });
  } catch (logErr) {
    // Best-effort: never throw from the logger. The caller's failure path
    // continues regardless of whether this row landed.
    console.error("[mcp:logger] failed to write error log to D1:", logErr);
  }
}
