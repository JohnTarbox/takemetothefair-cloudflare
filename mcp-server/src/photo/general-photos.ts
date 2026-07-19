/**
 * OPE-205 §3 — general (non-booth) fair photos → event gallery candidates.
 *
 * The booth classifier's "skip" bucket is the fairgoer's-eye scenery John also
 * sends: midway, food row, grandstand. Before this they were counted and
 * discarded. Now each one is attached to the resolved event as an `event_photos`
 * row (OPE-212).
 *
 * ── Why this crosses to the main app instead of writing D1 directly ──────────
 * The MCP Worker is a separate build with no path into `src/`, and the whole
 * upload pipeline lives there: EXIF/GPS strip, WebP transform, R2 put under the
 * public CDN prefix, and the `event_photos` insert. Writing the row from here
 * would mean either duplicating that pipeline (drift) or storing an unstripped
 * original on the public CDN — a GPS leak of exactly the kind
 * `src/lib/image-optim.ts` exists to prevent. So we POST the bytes over
 * X-Internal-Key and let the one pipeline do it, same shape as `venues_geocode`.
 *
 * ── Why this can't clobber a hero ───────────────────────────────────────────
 * `image_role: "gallery"` appends an `event_photos` row and touches no scalar
 * column, so `events.image_url` is structurally out of reach. OPE-205's "without
 * clobbering an existing hero" is satisfied by construction, not by a check.
 *
 * ── Why writing these now is safe ───────────────────────────────────────────
 * OPE-212's PUBLIC gallery block is STOP-gated and unshipped, so an
 * `event_photos` row renders nowhere today. Until that gate opens these rows are
 * a private staging area — which is exactly what "gallery/hero *candidates*"
 * asks for.
 */

export interface GeneralPhoto {
  /** R2 key under inbound-attachments/... */
  key: string;
  name: string;
  /** Sniffed at receive-time; the pipeline re-checks magic bytes anyway. */
  contentType?: string;
}

export interface GeneralPhotoEnv {
  VENDOR_ASSETS?: R2Bucket;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export interface GeneralPhotoResult {
  /** Rows created in event_photos. */
  attached: number;
  /** Photos we tried but couldn't attach — reported, never silently dropped. */
  failed: number;
  /** Per-failure reason (missing R2 object, upload-<status>, threw-<msg>), so a
   *  non-zero `failed` says WHY, not just how many. Empty on full success. */
  failures?: string[];
  /** Set when the lane is unconfigured, so a no-op is never silent. */
  disabledReason?: string;
}

/** Belt-and-braces bound; receive-time capture already caps at 5 attachments. */
export const MAX_GENERAL_PHOTOS = 5;

/**
 * Attach general photos to `eventId` as gallery candidates.
 *
 * Fail-soft per photo: one bad attachment must not sink the batch or the
 * (already-correct) fair match. Returns counts for the reply.
 */
export async function attachGeneralPhotos(
  env: GeneralPhotoEnv,
  eventId: string,
  photos: GeneralPhoto[]
): Promise<GeneralPhotoResult> {
  if (photos.length === 0) return { attached: 0, failed: 0 };

  const bucket = env.VENDOR_ASSETS;
  if (!bucket || !env.MAIN_APP_URL || !env.INTERNAL_API_KEY) {
    return {
      attached: 0,
      failed: 0,
      disabledReason:
        "VENDOR_ASSETS + MAIN_APP_URL + INTERNAL_API_KEY are required to attach photos",
    };
  }

  let attached = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const photo of photos.slice(0, MAX_GENERAL_PHOTOS)) {
    try {
      const obj = await bucket.get(photo.key);
      if (!obj) {
        failed++;
        failures.push(`missing-r2-object:${photo.key}`);
        continue;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const contentType =
        photo.contentType ?? obj.httpMetadata?.contentType ?? "application/octet-stream";

      const formData = new FormData();
      formData.append("file", new Blob([bytes], { type: contentType }), photo.name || "photo");
      formData.append("target_type", "event");
      formData.append("target_id", eventId);
      formData.append("image_role", "gallery");

      const url = `${env.MAIN_APP_URL}/api/admin/upload-image-bytes`;
      const init: RequestInit = {
        method: "POST",
        headers: { "X-Internal-Key": env.INTERNAL_API_KEY },
        body: formData,
      };
      const res = env.MAIN_APP
        ? await env.MAIN_APP.fetch(new Request(url, init))
        : await fetch(url, init);

      if (res.ok) {
        attached++;
      } else {
        failed++;
        // A short body snippet turns "failed=1" into an actionable cause
        // (401 auth, 413 too-large, 400 content-type, 404 target).
        const detail = await res
          .text()
          .then((t) => t.slice(0, 120))
          .catch(() => "");
        failures.push(`upload-${res.status}:${detail}`);
      }
    } catch (e) {
      failed++;
      failures.push(`threw:${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
  }

  return failures.length > 0 ? { attached, failed, failures } : { attached, failed };
}
