/**
 * OPE-204 Milestone B — booth-photo AUTO-WRITE.
 *
 * Milestone A staged every booth for review; this turns the high-confidence
 * subset (`disposition.action === "write"`) into real vendors via the SHARED
 * write tail `@takemetothefair/vendor-linking` — the same code the MCP tool and
 * OPE-205 §2's manual approve run, so an auto-write and a hand-approve produce an
 * identical row by construction.
 *
 * ── Why the writes are sequential ─────────────────────────────────────────
 * All booths in one email link to the SAME event. OPE-176's wrong-echo lesson:
 * concurrent event_vendors writes can return a stale echoed id. One at a time,
 * awaited, sidesteps it entirely (a batch of 5 is trivially cheap).
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 * Each successful auto-write drops a `vendor.photo_autowritten` marker keyed to
 * the email + photo_key. A re-processed / re-sent email skips any photo already
 * marked, so a booth is never written twice. (createOrLinkVendor also dedups the
 * vendor + upserts the link, so even without the marker a re-run wouldn't
 * duplicate — the marker additionally stops a redundant hero upload + AI spend.)
 */
import { and, eq } from "drizzle-orm";
import { createOrLinkVendor } from "@takemetothefair/vendor-linking";
import { adminActions, vendors } from "../schema.js";
import { recomputeVendorCompleteness, logEnrichment } from "../helpers.js";
import type { Db } from "../db.js";
import type { BoothIdentification } from "./vision.js";

/** Audit + idempotency marker for an auto-written booth. */
export const BOOTH_AUTOWRITTEN_ACTION = "vendor.photo_autowritten";

export interface AutoWriteEnv {
  VENDOR_ASSETS?: R2Bucket;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export interface AutoWriteItem {
  photoKey: string;
  photoName: string;
  id: BoothIdentification;
}

export interface AutoWriteOutcome {
  photoKey: string;
  businessName: string;
  vendorId: string | null;
  wasCreated: boolean;
  wasAlreadyLinked: boolean;
  heroSet: boolean;
  /** Present when the write failed — reported, never swallowed. */
  error?: string;
}

/**
 * Promote a booth photo to the vendor's logo when it has none. Crosses to the
 * app upload pipeline over X-Internal-Key (EXIF/GPS stripped, WebP, R2) rather
 * than storing the raw inbound original on the public CDN — the same path
 * OPE-205 §3's general-photos and §2's approve route use. Best-effort.
 */
async function setHeroIfBlank(
  env: AutoWriteEnv,
  db: Db,
  vendorId: string,
  photoKey: string
): Promise<boolean> {
  if (!env.VENDOR_ASSETS || !env.MAIN_APP_URL || !env.INTERNAL_API_KEY) return false;
  try {
    const [v] = await db
      .select({ logoUrl: vendors.logoUrl })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (!v || v.logoUrl) return false; // hero-IF-BLANK: never overwrite

    const obj = await env.VENDOR_ASSETS.get(photoKey);
    if (!obj) return false;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const contentType = obj.httpMetadata?.contentType ?? "image/jpeg";

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), `booth-${vendorId}`);
    form.append("target_type", "vendor");
    form.append("target_id", vendorId);
    // image_role defaults to "logo" for a vendor target.

    const url = `${env.MAIN_APP_URL}/api/admin/upload-image-bytes`;
    const init: RequestInit = {
      method: "POST",
      headers: { "X-Internal-Key": env.INTERNAL_API_KEY },
      body: form,
    };
    const res = env.MAIN_APP
      ? await env.MAIN_APP.fetch(new Request(url, init))
      : await fetch(url, init);
    return res.ok;
  } catch {
    return false;
  }
}

/** Photo keys already auto-written for this email (re-send dedup). */
async function alreadyWrittenKeys(db: Db, inboundEmailId: string): Promise<Set<string>> {
  const rows = await db
    .select({ payloadJson: adminActions.payloadJson })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, BOOTH_AUTOWRITTEN_ACTION),
        eq(adminActions.targetType, "inbound_email"),
        eq(adminActions.targetId, inboundEmailId)
      )
    );
  const keys = new Set<string>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payloadJson ?? "{}") as { photo_key?: string };
      if (p.photo_key) keys.add(p.photo_key);
    } catch {
      /* skip malformed */
    }
  }
  return keys;
}

/**
 * Auto-write the high-confidence booths for one email. SEQUENTIAL. Returns one
 * outcome per photo actually processed (skips already-written keys). Fail-soft
 * per photo: one bad write must not sink the rest or the staging of the others.
 */
export async function autoWriteBooths(
  env: AutoWriteEnv,
  db: Db,
  inboundEmailId: string,
  eventId: string,
  items: AutoWriteItem[]
): Promise<AutoWriteOutcome[]> {
  if (items.length === 0) return [];
  const done = await alreadyWrittenKeys(db, inboundEmailId);
  const out: AutoWriteOutcome[] = [];

  for (const it of items) {
    if (done.has(it.photoKey)) continue; // re-send dedup
    const businessName = it.id.businessName ?? "";
    if (!businessName) continue; // disposition guarantees a name for "write", belt+braces

    let result;
    try {
      result = await createOrLinkVendor(
        db,
        {
          eventId,
          businessName,
          website: it.id.website ?? null,
          products: it.id.products,
          status: "CONFIRMED",
          participationType: "EXHIBITOR",
        },
        { actorUserId: null, recomputeVendorCompleteness, logEnrichment }
      );
    } catch (e) {
      out.push({
        photoKey: it.photoKey,
        businessName,
        vendorId: null,
        wasCreated: false,
        wasAlreadyLinked: false,
        heroSet: false,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    if (!result.ok) {
      out.push({
        photoKey: it.photoKey,
        businessName,
        vendorId: null,
        wasCreated: false,
        wasAlreadyLinked: false,
        heroSet: false,
        error: result.error,
      });
      continue;
    }

    const heroSet = await setHeroIfBlank(env, db, result.vendorId, it.photoKey);

    // Idempotency marker + §1 audit. Keyed to the email so a re-run finds it.
    await db.insert(adminActions).values({
      action: BOOTH_AUTOWRITTEN_ACTION,
      actorUserId: null,
      targetType: "inbound_email",
      targetId: inboundEmailId,
      payloadJson: JSON.stringify({
        event_id: eventId,
        photo_key: it.photoKey,
        vendor_id: result.vendorId,
        business_name: businessName,
        was_created: result.wasCreated,
        was_linked: result.wasLinked,
        was_already_linked: result.wasAlreadyLinked,
        hero_set: heroSet,
      }),
      createdAt: new Date(),
    } as never);

    out.push({
      photoKey: it.photoKey,
      businessName,
      vendorId: result.vendorId,
      wasCreated: result.wasCreated,
      wasAlreadyLinked: result.wasAlreadyLinked,
      heroSet,
    });
  }

  return out;
}
