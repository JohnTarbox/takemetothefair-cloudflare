# K17 image upload via one-shot slot

How to attach a local image file to an event / vendor / venue without first hosting the bytes on a public URL — the workflow K17 from Dev-Email-2026-06-07.md closes.

## TL;DR

```text
1. Call MCP tool: request_image_upload_slot({target_type, target_id})
   → returns {upload_url, expires_at, max_bytes, ...}
2. POST raw bytes (or multipart) to upload_url within 5 minutes
   → returns CDN URL + Phase 2b metadata (same shape as upload_image_bytes)
3. The slot URL is one-shot — consumed on first successful POST.
```

The bytes flow Claude Desktop → main app over HTTPS directly; they never round-trip through the MCP channel. This is what sidesteps the "Claude model can't reliably emit ~500KB of base64 in a tool-call argument" ceiling that `upload_image_bytes` hits in practice.

## When to use which tool

| Tool                                    | When                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `upload_event_image`                    | The image is **already hosted** at a public URL (e.g. event flyer on the promoter's site). Pass the URL; main app fetches + processes.   |
| `upload_image_bytes`                    | The image is **small enough** to base64-emit (≲ 100 KB raw bytes → ≲ 135 KB base64). Inline the bytes in the tool argument. Single-call. |
| `request_image_upload_slot` + HTTP POST | The image is **on disk** (phone photo, downloaded flyer) and too large for base64 in a tool arg. Two steps: slot, then POST.             |

## End-to-end flow

### Step 1 — Mint a slot

MCP tool, admin only:

```jsonc
// Tool: request_image_upload_slot
{
  "target_type": "event", // "event" | "vendor" | "venue"
  "target_id": "39c9c2e8-5e87-4fa1-8b7e-...", // UUID
  "caption": "Kingfield ArtWalk banner", // optional, ≤ 200 chars
}
```

Response:

```jsonc
{
  "upload_url": "https://meetmeatthefair.com/api/admin/upload-image-direct/<token>",
  "expires_at": "2026-06-07T18:42:00.000Z",
  "max_bytes": 10485760, // 10 MB
  "allowed_types": ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/svg+xml"],
  "target_type": "event",
  "target_id": "39c9c2e8-5e87-4fa1-8b7e-...",
  "instructions": "POST raw image bytes …",
}
```

### Step 2a — POST raw bytes

The simplest path. Content-Type IS the image MIME type:

```bash
curl -X POST \
  -H "Content-Type: image/jpeg" \
  --data-binary @./kingfield-artwalk.jpg \
  "https://meetmeatthefair.com/api/admin/upload-image-direct/<token>"
```

### Step 2b — POST multipart (alternative)

If your HTTP client only does multipart forms:

```bash
curl -X POST \
  -F "file=@./kingfield-artwalk.jpg;type=image/jpeg" \
  -F "caption=Updated banner" \
  "https://meetmeatthefair.com/api/admin/upload-image-direct/<token>"
```

A `caption` field in the multipart body overrides any caption captured at slot-mint time.

### Step 3 — Inspect response

The response shape is **identical** to `upload_image_bytes` so any caller code already handling that endpoint's response works unchanged:

```jsonc
{
  "url": "https://cdn.meetmeatthefair.com/events/<id>/image-<ts>.webp",
  "key": "events/<id>/image-<ts>.webp",
  "content_type": "image/webp",
  "target_type": "event",
  "target_id": "...",
  "image_column": "imageUrl",
  "bytes_stored": 84210,
  "bytes_removed_by_exif_strip": 1432,
  "exif_segments_stripped": 1,
  "over_soft_budget": false,
  "soft_size_limit_bytes": 524288,
  "optimization": "phase-2b",
  "phase2b": {
    "status": "applied",
    "skip_reason": null,
    "error_detail": null,
    "width": 2000,
    "height": 1125,
    "duration_ms": 412,
    "compression_ratio": 0.123,
  },
}
```

The same Phase 2a (EXIF strip) + Phase 2b (auto-orient + 2000px WebP) pipeline runs as `upload_image_bytes` — bytes-arrival channel is the only difference.

## Security model

| Concern                            | Mitigation                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who can mint a slot?               | Admin session OR `X-Internal-Key` (the MCP server). Enforced at `/api/admin/upload-image-slot`.                                                                                                  |
| What if the slot URL leaks?        | 5-minute TTL bounds replay. The token is tied to a specific `target_type` + `target_id` at mint time — a leaked URL can only ever upload to the same row it was minted for.                      |
| Can a slot be used multiple times? | No. `consumeUploadSlot` deletes the KV entry before returning claims. Second POST returns 401.                                                                                                   |
| What's signed into the token?      | Nothing — the token IS the random KV key. Claims (target_type/target_id/maxBytes/issuedBy) live in KV value, not in the token itself. Token length is ≥ 16 chars of base64url (24 random bytes). |
| What if KV is unbound?             | Slot endpoint returns 500 + logs to `error_logs`; direct endpoint returns 401 (indistinguishable from "bad token" to avoid revealing infra state).                                               |

## Failure modes

| HTTP                                              | Meaning                                                                        | Recovery                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 401 from `/api/admin/upload-image-slot`           | Caller is not admin + didn't send `X-Internal-Key`.                            | Verify auth context.                                                                                                            |
| 404 from `/api/admin/upload-image-slot`           | `target_id` doesn't exist for the given `target_type`.                         | Double-check the UUID.                                                                                                          |
| 401 from `/api/admin/upload-image-direct/[token]` | Token unknown / expired / already consumed.                                    | Re-mint via `request_image_upload_slot`.                                                                                        |
| 400 from `/api/admin/upload-image-direct/[token]` | Body issues — wrong Content-Type, bytes don't match declared type, empty file. | Fix the upload; the slot is consumed on a successful claim retrieval, so if you hit this AFTER claim load, you need a new slot. |
| 413                                               | File > slot's `max_bytes` (10 MB default).                                     | Compress / resize client-side; re-mint a slot.                                                                                  |
| 502                                               | R2 put or DB update failed.                                                    | Retry (with a fresh slot if the slot was consumed). Response includes the R2 URL if DB write failed but R2 succeeded.           |

## Smoke procedure

Before declaring K17 closed in production, run this end-to-end:

```bash
# 1. Pick a known event id (or vendor / venue)
EVENT_ID="…"

# 2. Mint a slot via the MCP path (from a Claude session) OR direct curl with INTERNAL_API_KEY:
SLOT=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: $INTERNAL_API_KEY" \
  -d "{\"target_type\":\"event\",\"target_id\":\"$EVENT_ID\"}" \
  "https://meetmeatthefair.com/api/admin/upload-image-slot")
UPLOAD_URL=$(echo "$SLOT" | jq -r .upload_url)

# 3. POST a test JPEG
curl -X POST \
  -H "Content-Type: image/jpeg" \
  --data-binary @./test.jpg \
  "$UPLOAD_URL"
# → expect a JSON response with url + phase2b.status="applied"

# 4. Verify the slot is dead
curl -X POST -H "Content-Type: image/jpeg" --data-binary @./test.jpg "$UPLOAD_URL"
# → expect 401 "Invalid or expired upload slot"

# 5. Verify the event's image_url now points at the CDN
curl -s "https://meetmeatthefair.com/events/<slug>" | grep cdn.meetmeatthefair.com
```

## Related

- Source:
  - MCP tool: `mcp-server/src/tools/request-image-upload-slot.ts`
  - Slot mint: `src/app/api/admin/upload-image-slot/route.ts`
  - Slot consume: `src/app/api/admin/upload-image-direct/[token]/route.ts`
  - Token store: `src/lib/upload-slot-token.ts`
  - Pipeline (shared with upload_image_bytes): `src/lib/upload-image-pipeline.ts`
- Memory: `[[project_k17_upload_slot_design]]`, `[[feedback_mcp_resources_channel_is_server_to_client]]`
- Related design constraint: MCP protocol has no client→server file-content transfer primitive today (Resources flow server→client; Roots only advertises paths).
