import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

/**
 * Wraps an API route handler with:
 * - Correlation ID (X-Request-Id header) for tracing
 * - Automatic error catching and logging
 * - Consistent 500 response format
 */
export function withErrorHandler(handler: RouteHandler, source: string): RouteHandler {
  return async (request, context) => {
    const requestId = crypto.randomUUID();

    try {
      const response = await handler(request, context);

      // Attach correlation ID to all responses
      response.headers.set("X-Request-Id", requestId);
      return response;
    } catch (error) {
      // Log to D1
      let db = null;
      try {
        db = getCloudflareDb();
      } catch {
        // DB unavailable — console logging still happens in logError
      }

      await logError(db, {
        message: `Unhandled error in ${source}`,
        error,
        source,
        request,
        context: { requestId },
        statusCode: 500,
      });

      return NextResponse.json(
        {
          error: "Internal server error",
          requestId,
        },
        {
          status: 500,
          headers: { "X-Request-Id": requestId },
        }
      );
    }
  };
}
