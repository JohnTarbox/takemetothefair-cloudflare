/** Collapse near-identical messages so rows that differ only by a URL/entity
 *  name or a count fold into one group: lower-case, unicode dashes → "-",
 *  digit runs → "#", and quoted values → `"…"` (OPE-1270: a NAME_DRIFT row
 *  carries `ours "X" · site "Y"` as per-row evidence, which must not split the
 *  group any more than a status code does). Lives here, not in the page: a page module may only export Next's names. */
export function normalizeHealthMessageKey(message: string | null): string {
  if (!message) return "";
  return message
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, "#")
    .trim();
}
