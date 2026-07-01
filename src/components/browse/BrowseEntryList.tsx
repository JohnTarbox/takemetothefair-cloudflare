import Link from "next/link";
import type { BrowseEntry } from "@/lib/browse/directory";

/**
 * OPE-40 — renders a flat, multi-column list of plain crawlable `<a href>`
 * links (one per entity). Server component; the anchors are in the SSR HTML so
 * a crawler reaches every linked detail page without executing JS.
 */
export function BrowseEntryList({
  entries,
  basePath,
}: {
  entries: BrowseEntry[];
  basePath: string;
}) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground">No entries in this group.</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((e) => (
        <li key={e.slug} className="truncate">
          <Link href={`${basePath}/${e.slug}`} className="text-navy hover:underline">
            {e.name}
          </Link>
          {e.state ? <span className="ml-1 text-sm text-muted-foreground">· {e.state}</span> : null}
        </li>
      ))}
    </ul>
  );
}
