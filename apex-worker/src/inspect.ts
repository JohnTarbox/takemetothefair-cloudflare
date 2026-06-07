/**
 * K2 Phase B (2026-06-07): pure marker-detection helper for the apex
 * Worker. Extracted into its own file so it can be unit-tested without
 * spinning up the full Workers runtime.
 *
 * The K1 error UI marker is emitted by src/app/error.tsx and
 * src/app/global-error.tsx as the first child of the outermost rendered
 * element, gated by `isFetchError === true`:
 *
 *   <span data-x-render-error="fetch" hidden>fetch</span>
 *
 * Why hidden span vs <meta>:
 *  - Next.js doesn't auto-hoist JSX <meta> from a client component (and
 *    error.tsx requires "use client"); placing <meta> in the body is
 *    invalid HTML5.
 *  - Hidden span is valid HTML, semantically inert (suppresses display
 *    + screen readers), and stable to grep against.
 *  - Data-attribute spelling is grep-stable across Tailwind / className
 *    shuffles — visible UI copy can drift without the marker drifting.
 *
 * Why first child:
 *  - The marker lands in the first chunk of the streaming HTML body —
 *    we can detect it without reading the entire response.
 *
 * The match is a plain substring scan. We don't parse HTML (no need;
 * the marker has a fixed attribute spelling that won't collide with
 * normal page content) and we don't use HTMLRewriter at the inspection
 * stage (HTMLRewriter is one-pass streaming, which makes
 * "decide-status-after-seeing-marker" awkward — we'd still need to
 * buffer to decide before sending headers).
 */

export const ERROR_MARKER = 'data-x-render-error="fetch"';

/**
 * Detect the K1 error marker in an HTML body. Plain substring match
 * against the data attribute. Tests pin the exact spelling so a typo in
 * either error.tsx or global-error.tsx surfaces as a unit-test failure
 * before deploy rather than as a silent status-rewrite no-op.
 */
export function hasErrorMarker(body: string): boolean {
  return body.includes(ERROR_MARKER);
}
