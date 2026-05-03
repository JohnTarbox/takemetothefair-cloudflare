/**
 * Admin page-snapshot endpoint.
 *
 * Use case (from analyst's R5 list, item 4.4): let Claude Cowork (or any
 * admin-authenticated tool) verify a UI change without the human copy-pasting.
 * `GET /api/admin/snapshot?path=/admin/analytics?tab=recommendations` returns
 * the rendered HTML the admin would see in their browser, plus extracted
 * <title>, meta-description, and a plain-text excerpt for quick LLM scanning.
 *
 * Approach: server-side fetch back into our own host with the caller's Cookie
 * header forwarded. Works because Workers can fetch() their own host, and the
 * session cookie authenticates the inner request the same way it authenticates
 * the outer one. Avoids needing Browser Rendering bindings (overkill for SSR
 * pages) or trying to render the React tree manually (impossible — Server
 * Components need the request context).
 *
 * Path safety:
 *   - Must be a relative path (starts with "/").
 *   - Disallow protocol-prefixed paths and double-slash (which fetch() would
 *     interpret as protocol-relative URL → SSRF).
 *   - Cap to a sane length.
 *
 * Auth: ADMIN role only. Token-auth (mmatf_…) also works since we go through
 * getAuthorizedSession().
 *
 * Caveat: client-side hydration content (anything that React adds via
 * useEffect after mount) won't appear in the snapshot. For most admin pages
 * the SSR HTML is enough; if a snapshot is missing data, the offending
 * component is client-only and needs different telemetry.
 */

import { NextResponse } from "next/server";
import { getAuthorizedSession } from "@/lib/api-auth";
import { auth } from "@/lib/auth";

export const runtime = "edge";

const MAX_PATH_LENGTH = 512;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB cap on rendered HTML.
const FETCH_TIMEOUT_MS = 15_000;

function isPathSafe(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith("/")) return false;
  // Block "//" (protocol-relative URL) and explicit protocol prefixes.
  if (path.startsWith("//")) return false;
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  return true;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractMetaDescription(html: string): string | null {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  return m ? m[1] : null;
}

function htmlToText(html: string): string {
  // Best-effort plain-text excerpt. Strips scripts/styles, then tags. Leaves
  // whitespace-collapsed runs of words readable for an LLM consumer. Not a
  // replacement for a real DOM-based extractor; sufficient for "what does
  // this admin page say".
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(request: Request) {
  const authz = await getAuthorizedSession(request);
  if (!authz.authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // For session-based callers, also require ADMIN role. Token callers
  // (mmatf_…) are already gated to admin scope by the token model.
  if (!authz.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const session = await auth();
  const isTokenCall = session?.user == null;
  if (!isTokenCall && session?.user?.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path || !isPathSafe(path)) {
    return NextResponse.json(
      { error: "invalid_path", message: "path must be a relative path starting with /" },
      { status: 400 }
    );
  }

  // Build the same-origin URL. We trust the request's host since we're going
  // back into ourselves; the only attack surface is `path`, validated above.
  const targetUrl = `${url.origin}${path}`;

  const cookie = request.headers.get("cookie") ?? "";
  const userAgent = request.headers.get("user-agent") ?? "MMATF-Snapshot/1.0";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      // Forward the cookie so SSR sees the same session the snapshot caller had.
      headers: {
        Cookie: cookie,
        "User-Agent": userAgent,
        // Prevent recursive snapshots if some code path interprets this as
        // an internal call.
        "X-Snapshot-Pass-Through": "1",
      },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (e) {
    clearTimeout(timer);
    return NextResponse.json(
      {
        error: "fetch_failed",
        message: e instanceof Error ? e.message : "fetch failed",
      },
      { status: 502 }
    );
  }
  clearTimeout(timer);

  // 3xx → return the redirect target so the caller can decide whether to
  // follow. Manually-captured to avoid surprising 200-on-login-redirect
  // behavior that would silently substitute the login page for the requested
  // admin page.
  if (upstream.status >= 300 && upstream.status < 400) {
    return NextResponse.json({
      status: upstream.status,
      location: upstream.headers.get("location"),
      path,
    });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    return NextResponse.json(
      {
        status: upstream.status,
        contentType,
        message: "snapshot only supports text/html responses",
      },
      { status: 415 }
    );
  }

  // Read with a byte cap so we don't blow the response budget on a huge page.
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return NextResponse.json(
      {
        status: upstream.status,
        message: `response too large (${buf.byteLength} bytes; cap ${MAX_RESPONSE_BYTES})`,
      },
      { status: 413 }
    );
  }

  const html = new TextDecoder("utf-8").decode(buf);
  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const text = htmlToText(html);

  return NextResponse.json({
    status: upstream.status,
    path,
    title,
    description,
    bytes: buf.byteLength,
    // Plain-text excerpt — primary consumer is LLM-driven verification.
    text,
    // Raw HTML included so callers that need it (e.g. testing a specific
    // class is rendered) can grep without a second round-trip. Truncated by
    // the byte cap above.
    html,
  });
}
