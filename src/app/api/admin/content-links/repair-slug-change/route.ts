export const dynamic = "force-dynamic";
/**
 * A3.3 / K43 — slug-change auto-repair endpoint.
 *
 * Rewrites every blog body that links to an entity's OLD slug so it points at
 * the NEW canonical, and re-syncs the content_links index. Thin HTTP wrapper
 * around `repairBlogLinksForSlugChange` so the MCP Worker's `update_event`
 * (which renames event slugs in a separate worker) can fire the repair over
 * `X-Internal-Key`. In-process callers in the main app (event admin edit,
 * merge) call the lib helper directly instead of round-tripping through here.
 *
 * Auth: admin session OR X-Internal-Key. Body: { targetType, oldSlug, newSlug }.
 */
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { repairBlogLinksForSlugChange } from "@/lib/content-links-sync";
import type { ContentLinkTargetType } from "@/lib/blog-links";
import { logError } from "@/lib/logger";

const VALID_TYPES: ReadonlySet<string> = new Set(["EVENT", "VENDOR", "VENUE", "BLOG_POST"]);

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { targetType?: unknown; oldSlug?: unknown; newSlug?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const targetType = typeof body.targetType === "string" ? body.targetType.toUpperCase() : "";
  const oldSlug = typeof body.oldSlug === "string" ? body.oldSlug : "";
  const newSlug = typeof body.newSlug === "string" ? body.newSlug : "";

  if (!VALID_TYPES.has(targetType) || !oldSlug || !newSlug) {
    return NextResponse.json(
      { error: "targetType (EVENT|VENDOR|VENUE|BLOG_POST), oldSlug and newSlug are required" },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();
  try {
    const result = await repairBlogLinksForSlugChange(
      db,
      targetType as ContentLinkTargetType,
      oldSlug,
      newSlug
    );
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    await logError(db, {
      source: "api/admin/content-links/repair-slug-change",
      message: "repair-slug-change threw",
      error: e,
      context: { targetType, oldSlug, newSlug },
    });
    return NextResponse.json(
      { error: "repair_failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
