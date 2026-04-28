import { NextResponse } from "next/server";
import { getCloudflareEnv } from "@/lib/cloudflare";

export const runtime = "edge";

/**
 * IndexNow key verification file.
 *
 * Served at https://meetmeatthefair.com/api/indexnow-key/<KEY>.txt.
 * The IndexNow spec allows the key file in any sub-directory as long as
 * the keyLocation parameter is supplied in the API call — see
 * src/lib/indexnow.ts which always passes keyLocation explicitly.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ indexnowKey: string }> }
) {
  const { indexnowKey } = await params;

  const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
  const key = env.INDEXNOW_KEY;

  if (!key || indexnowKey !== `${key}.txt`) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(key, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
