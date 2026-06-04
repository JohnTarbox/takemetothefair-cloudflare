/**
 * UR1 C4 (2026-06-04) — admin resolve action for a problem report.
 * Sets resolved_at + resolved_by_user_id + notes, then redirects back
 * to the detail page.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { problemReports } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

export const runtime = "edge";

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
  const notes = ((form.get("notes") as string | null) ?? "").trim().slice(0, 2000) || null;

  const db = getCloudflareDb();
  await db
    .update(problemReports)
    .set({
      resolvedAt: new Date(),
      resolvedByUserId: session.user.id,
      notes,
    })
    .where(eq(problemReports.id, id));

  return NextResponse.redirect(new URL(`/admin/problem-reports/${id}`, req.url), 303);
}
