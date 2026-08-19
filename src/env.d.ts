interface CloudflareEnv {
  DB: D1Database;
  AI: Ai;
  RATE_LIMIT_KV: KVNamespace;
  GOOGLE_MAPS_API_KEY?: string;
  /**
   * OPE-294 — may the Google Places backfill write a Places photo URL straight
   * into `venues.image_url`?
   *
   * Ships unset (falsy). That single line produced 172 of our 173 hotlinked
   * venue images, and the licensing question — Google Maps Platform terms
   * restrict storing/caching/proxying Places photos and require photographer
   * attribution — is John's to answer, not this code's to assume. The flag
   * exists so the answer is one edit either way rather than a revert.
   */
  ALLOW_GOOGLE_PLACES_PHOTOS?: string;
  // ENG1.8 — GA4 Measurement Protocol (server-side outbound-click mirror).
  // GA4_MEASUREMENT_ID is the public "G-XXXX" data-stream id; GA4_MP_API_SECRET
  // is a secret minted in GA4 Admin → Data Streams → Measurement Protocol.
  GA4_MEASUREMENT_ID?: string;
  GA4_MP_API_SECRET?: string;
}
