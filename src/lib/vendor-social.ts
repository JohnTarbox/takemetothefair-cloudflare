// D1 stores vendor `social_links` as TEXT (JSON string); callers must route
// through this helper rather than spreading or Object.values()-ing directly.
export function parseVendorSocialLinks(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parseVendorSocialLinks(parsed);
      }
    } catch {
      /* malformed JSON falls through to empty */
    }
  }
  return {};
}
