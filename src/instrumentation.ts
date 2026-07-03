/**
 * OPE-80 — server-side render-error capture.
 *
 * `onRequestError` is Next's STABLE (15.3+) hook fired for every uncaught
 * server-side error (render, route handler, server action). We use it to
 * persist the REAL error — message + stack + digest + route — which React
 * otherwise redacts to an opaque digest before it reaches the browser.
 *
 * The imports are dynamic so instrumentation stays lean and does NOT eagerly
 * touch the Cloudflare request context at module-load time (getCloudflareDb
 * reads `getCloudflareContext()`, which is only valid inside a request).
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context?: { routerKind?: string; routeType?: string; routePath?: string }
): Promise<void> {
  try {
    const { getCloudflareDb } = await import("@/lib/cloudflare");
    const { captureServerRenderError } = await import("@/lib/observability/capture-render-error");
    await captureServerRenderError(getCloudflareDb(), { error, request, context });
  } catch (e) {
    console.error("[onRequestError] capture failed", e);
  }
}
