export const dynamic = "force-dynamic";
/**
 * OPE-1178 — inline status change for one idea, from the /admin/ideas row form.
 * Admin only. Redirects back to the list the form was submitted from.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { productIdeas } from "@/lib/db/schema";
import { IDEA_STATUSES } from "@takemetothefair/db-schema";
import { auth } from "@/lib/auth";

interface Props {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: Props): Promise<Response> {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await params;
  const form = await req.formData();
  const status = String(form.get("status") ?? "");
  if (!(IDEA_STATUSES as readonly string[]).includes(status)) {
    return new Response(`Unknown status: ${status}`, { status: 400 });
  }

  await getCloudflareDb()
    .update(productIdeas)
    .set({ status: status as (typeof IDEA_STATUSES)[number], updatedAt: new Date() })
    .where(eq(productIdeas.id, id));

  // Only ever redirect inside the ideas page — `back` is form input.
  const back = String(form.get("back") ?? "");
  const target = back.startsWith("/admin/ideas") ? back : "/admin/ideas";
  return NextResponse.redirect(new URL(target, req.url), 303);
}
