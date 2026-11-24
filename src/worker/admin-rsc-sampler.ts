/**
 * OPE-1397 (fix) — record anonymous RSC hits on /admin* from the Worker ENTRY,
 * before Next.js sees the request.
 *
 * Why here and nowhere later: Next deletes every FLIGHT_HEADER (`RSC`,
 * `Next-Router-State-Tree`, `Next-Router-Prefetch`, …) before user code can
 * read it, at BOTH places we might otherwise look:
 *
 *   - middleware: node_modules/next/dist/server/web/adapter.js:137-146
 *     (`if (!isEdgeRendering) for (const header of FLIGHT_HEADERS)
 *     requestHeaders.delete(header)`). The first version of this sampler lived
 *     in src/middleware.ts and wrote 0 rows in prod on two live probes, while
 *     its unit test (which called `middleware()` directly, skipping the
 *     adapter) was green.
 *   - render (`headers()` in a server component / requireAdmin):
 *     node_modules/next/dist/server/async-storage/request-store.js:33-38
 *     (`getHeaders` deletes FLIGHT_HEADERS from the sealed headers it hands to
 *     `headers()`).
 *
 * The only code that sees the raw request is the Worker's own `fetch`, so
 * `worker.mjs` (wrangler.toml `main`) wraps OpenNext's generated
 * `.open-next/worker.js` with `withAdminRscSampler`.
 *
 * Contract (unchanged from the original design): path, timestamp, CF country
 * and ASN only — no headers, no IP, no UA. Fire-and-forget via
 * `ctx.waitUntil`; never throws, never delays or alters the response.
 * No heartbeat probe, by design: "no rows" is the healthy state.
 */
import { drizzle } from "drizzle-orm/d1";
import {
  ADMIN_RSC_ANON_KIND,
  isAnonymousAdminRscRequest,
  writeRequestSample,
} from "../lib/request-sampling";

type WaitUntilCtx = { waitUntil(promise: Promise<unknown>): void };
type SamplerEnv = { DB?: D1Database } | undefined;
type FetchHandler<E, C> = (request: Request, env: E, ctx: C) => Promise<Response> | Response;

/** Records the hit if it is the anonymous-RSC-on-/admin shape. Never throws. */
export function sampleAnonymousAdminRsc(
  request: Request,
  env: SamplerEnv,
  ctx: WaitUntilCtx
): void {
  try {
    const { pathname } = new URL(request.url);
    if (!isAnonymousAdminRscRequest(pathname, request.headers)) return;
    const d1 = env?.DB;
    if (!d1) return;
    const cf = (request as Request & { cf?: { asn?: number; country?: string } }).cf;
    ctx.waitUntil(
      writeRequestSample(drizzle(d1), {
        kind: ADMIN_RSC_ANON_KIND,
        path: pathname,
        asn: typeof cf?.asn === "number" ? cf.asn : null,
        country: request.headers.get("cf-ipcountry") ?? cf?.country ?? null,
      })
    );
  } catch {
    // sampling must never affect the response path
  }
}

/** Wraps a Worker default export so every request passes the sampler first. */
export function withAdminRscSampler<
  E extends SamplerEnv,
  C extends WaitUntilCtx,
  H extends { fetch: FetchHandler<E, C> },
>(handler: H): H {
  return {
    ...handler,
    fetch(request: Request, env: E, ctx: C) {
      sampleAnonymousAdminRsc(request, env, ctx);
      return handler.fetch(request, env, ctx);
    },
  };
}
