import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { getCloudflareEnv } from "@/lib/cloudflare";

export const runtime = "edge";

/**
 * IndexNow key verification file at the SITE ROOT.
 *
 * Per the IndexNow spec, the key file's location determines which URLs the
 * key authorizes: a key at `/<key>.txt` authorizes URLs across the entire
 * host, while a key in a subdirectory only authorizes URLs under that
 * subdirectory. Our submissions span /events/, /venues/, /blog/, so the
 * key must be served at the site root.
 *
 * Catches any top-level path of the form `<something>.txt` (or anything
 * else); returns the key bytes only when the segment exactly matches
 * `<INDEXNOW_KEY>.txt`. All other paths fall through to the framework's
 * not-found handler so styled 404 behavior for typos is preserved.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ indexnowKey: string }> }
) {
  const { indexnowKey } = await params;

  const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
  const key = env.INDEXNOW_KEY;

  if (!key || indexnowKey !== `${key}.txt`) {
    notFound();
  }

  return new NextResponse(key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
