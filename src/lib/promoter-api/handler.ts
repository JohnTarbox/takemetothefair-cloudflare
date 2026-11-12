/**
 * OPE-1620 — the one wrapper every /api/v1/promoter route runs through:
 * read the raw body, authenticate (auth.ts), rate-limit per key on the
 * BurstCounter Durable Object, run the route, and answer every failure in one
 * JSON shape: { error: { code, message, errors? } }.
 *
 * Failures are logged through the house logger with the route, the claimed
 * key_id and the error code. NEVER the secret, the signature header, or the
 * body (which a promoter may not expect us to keep).
 */
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getBurstLimiter } from "@/lib/burst-limiter";
import { isDeployedEnvironment } from "@/lib/runtime-env";
import { logError } from "@/lib/logger";
import { PROMOTER_API_RATE, authenticate } from "./auth";
import { readOnlyDb } from "@/lib/test-submission/read-only-db";
import { consumeRequestId, lookupApiKey, touchApiKey } from "./store";
import type { Caller, ServiceResult } from "./service";
import type { FieldError } from "./fields";

type Db = ReturnType<typeof getCloudflareDb>;

export const MAX_BODY_BYTES = 64 * 1024;

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: { errors?: FieldError[]; headers?: Record<string, string>; event_id?: string } = {}
): Response {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(extra.errors ? { errors: extra.errors } : {}),
        ...(extra.event_id ? { event_id: extra.event_id } : {}),
      },
    },
    { status, headers: extra.headers }
  );
}

export function serviceResponse(r: ServiceResult): Response {
  if (r.ok) return NextResponse.json(r.body, { status: r.httpStatus });
  return apiError(r.httpStatus, r.code, r.message, { errors: r.errors, event_id: r.event_id });
}

async function rateLimit(
  keyId: string
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const limiter = getBurstLimiter();
  if (!limiter) {
    // No BURST_COUNTER binding: unit tests and `next dev` run unlimited. A
    // deployed Worker without it is misconfigured; refuse rather than run uncapped.
    if (isDeployedEnvironment()) {
      console.error("[promoter-api] BURST_COUNTER binding missing in production — refusing");
      return { allowed: false, retryAfterSeconds: PROMOTER_API_RATE.periodSeconds };
    }
    return { allowed: true };
  }
  try {
    const v = await limiter.limit({
      key: `promoter-api:${keyId}`,
      max: PROMOTER_API_RATE.max,
      periodSeconds: PROMOTER_API_RATE.periodSeconds,
    });
    if (v.success) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.min(
        PROMOTER_API_RATE.periodSeconds,
        Math.max(1, v.retryAfterSeconds ?? PROMOTER_API_RATE.periodSeconds)
      ),
    };
  } catch (error) {
    // OPE-970 posture: a limiter that throws is logged, and the request is not
    // turned into a 500 (the signature has already been verified).
    console.error("[promoter-api] burst limiter threw; allowing", error);
    return { allowed: true };
  }
}

export interface ApiContext {
  db: Db;
  caller: Caller;
  body: string;
}

export async function withPromoterApi(
  request: Request,
  route: string,
  run: (ctx: ApiContext) => Promise<Response>
): Promise<Response> {
  const db = getCloudflareDb();
  const now = new Date();
  let keyId: string | undefined;
  const fail = async (
    status: number,
    code: string,
    message: string,
    extra: Parameters<typeof apiError>[3] = {},
    error?: unknown
  ) => {
    await logError(db, {
      message: `Promoter API ${status} ${code}`,
      error,
      level: status >= 500 ? "error" : "warn",
      source: "api/v1/promoter",
      route,
      statusCode: status,
      request,
      // Deliberately minimal: never the secret, the signature or the body.
      context: { code, key_id: keyId ?? null, method: request.method },
    });
    return apiError(status, code, message, extra);
  };

  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES)
      return fail(413, "body_too_large", `The body is larger than ${MAX_BODY_BYTES} bytes.`);
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES)
      return fail(413, "body_too_large", `The body is larger than ${MAX_BODY_BYTES} bytes.`);

    const auth = await authenticate(request.headers, body, Math.floor(now.getTime() / 1000), {
      lookupKey: (k) => lookupApiKey(db, k),
      consumeRequestId: (k, r) => consumeRequestId(db, k, r, now),
      rateLimit,
    });
    if (!auth.ok) {
      keyId = auth.keyId;
      return fail(auth.status, auth.code, auth.message, {
        headers: auth.retryAfterSeconds
          ? { "Retry-After": String(auth.retryAfterSeconds) }
          : undefined,
      });
    }
    keyId = auth.key.keyId;
    await touchApiKey(db, auth.key.keyId, now);
    const res = await run({
      // OPE-1625 — a test key's route gets a database that throws on any write,
      // so a route that forgets to honour `testKey` fails loudly instead of
      // publishing. The replay ledger and last-used stamp above are the only
      // writes a test key makes, exactly as for a dry run.
      db: auth.key.isTest ? readOnlyDb(db) : db,
      body,
      caller: {
        keyId: auth.key.keyId,
        promoterId: auth.key.promoterId,
        promoterUserId: auth.key.promoterUserId,
        requestId: auth.requestId,
        now,
        ...(auth.key.isTest ? { testKey: true } : {}),
      },
    });
    if (res.status >= 400) {
      // Log the failure code only; the response body is the caller's own data.
      const code = await res
        .clone()
        .json()
        .then((j) => (j as { error?: { code?: string } }).error?.code ?? "error")
        .catch(() => "error");
      await logError(db, {
        message: `Promoter API ${res.status} ${code}`,
        level: "warn",
        source: "api/v1/promoter",
        route,
        statusCode: res.status,
        request,
        context: { code, key_id: keyId, method: request.method },
      });
    }
    return res;
  } catch (error) {
    return fail(
      500,
      "internal_error",
      "Something went wrong on our side. Retry with a new X-MMATF-Request-Id.",
      {},
      error
    );
  }
}

/** Parse a JSON body; an empty body is `{}` when allowed. */
export function parseJson(
  body: string,
  allowEmpty: boolean
): { ok: true; value: unknown } | { ok: false; response: Response } {
  if (!body.trim() && allowEmpty) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return {
      ok: false,
      response: apiError(400, "invalid_json", "The body must be a JSON object."),
    };
  }
}
