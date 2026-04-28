/**
 * IndexNow protocol — instant URL submission to participating search engines
 * (Bing, Yandex, Seznam, Naver). Single endpoint, fire-and-forget.
 *
 * Spec: https://www.indexnow.org/documentation
 *
 * Set INDEXNOW_KEY as a Cloudflare Worker secret. The key file at
 * https://meetmeatthefair.com/<key>.txt is served by the catch-all route
 * src/app/[indexnowKey]/route.ts.
 *
 * NEVER throws to the caller. Logs success/failure to console for wrangler
 * tail observability.
 */

const HOST = "meetmeatthefair.com";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_BATCH_SIZE = 10_000;

function keyLocation(key: string): string {
  return `https://${HOST}/api/indexnow-key/${key}.txt`;
}

interface IndexNowEnv {
  INDEXNOW_KEY?: string;
}

export async function pingIndexNow(urls: string | string[], env: IndexNowEnv): Promise<void> {
  const key = env.INDEXNOW_KEY;
  if (!key) {
    console.warn("[IndexNow] INDEXNOW_KEY not configured — skipping ping");
    return;
  }

  const list = Array.isArray(urls) ? urls : [urls];
  const filtered = list
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u && u.startsWith(`https://${HOST}/`)));

  if (filtered.length === 0) return;

  try {
    if (filtered.length === 1) {
      const qs = new URLSearchParams({
        url: filtered[0],
        key,
        keyLocation: keyLocation(key),
      });
      const response = await fetch(`${INDEXNOW_ENDPOINT}?${qs.toString()}`, {
        method: "GET",
      });
      const body = response.ok ? "" : (await response.text()).slice(0, 200);
      console.log(`[IndexNow] GET ${filtered[0]} → ${response.status}${body ? " " + body : ""}`);
      return;
    }

    // Batch up to MAX_BATCH_SIZE per request
    for (let i = 0; i < filtered.length; i += MAX_BATCH_SIZE) {
      const chunk = filtered.slice(i, i + MAX_BATCH_SIZE);
      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: HOST,
          key,
          keyLocation: keyLocation(key),
          urlList: chunk,
        }),
      });
      const body = response.ok ? "" : (await response.text()).slice(0, 200);
      console.log(
        `[IndexNow] POST ${chunk.length} URLs → ${response.status}${body ? " " + body : ""}`
      );
    }
  } catch (error) {
    console.error("[IndexNow] Network error:", error);
  }
}

/** Construct the canonical public URL for a content slug. */
export function indexNowUrlFor(
  kind: "events" | "venues" | "vendors" | "blog",
  slug: string
): string {
  return `https://${HOST}/${kind}/${slug}`;
}
