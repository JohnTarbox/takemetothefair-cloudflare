import Link from "next/link";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  basePath: string;
  searchParams?: Record<string, string | undefined>;
  className?: string;
}

function buildHref(
  basePath: string,
  searchParams: Record<string, string | undefined> | undefined,
  page: number
) {
  const params = new URLSearchParams();
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "page") continue;
      if (value === undefined || value === "") continue;
      params.set(key, value);
    }
  }
  if (page > 1) params.set("page", page.toString());
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function Pagination({
  currentPage,
  totalPages,
  basePath,
  searchParams,
  className = "",
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const visiblePages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1
  );

  return (
    <nav
      aria-label="Pagination"
      className={`mt-8 flex justify-center flex-wrap gap-2 ${className}`}
    >
      {currentPage > 1 && (
        <Link
          href={buildHref(basePath, searchParams, currentPage - 1)}
          rel="prev"
          aria-label="Previous page"
          className="px-3 py-2 rounded-lg bg-stone-100 text-stone-900 hover:bg-stone-300 transition-colors"
        >
          &laquo;
        </Link>
      )}
      {visiblePages.map((p, idx, arr) => {
        const elements: React.ReactNode[] = [];
        if (idx > 0 && p - arr[idx - 1] > 1) {
          elements.push(
            <span key={`ellipsis-${p}`} className="px-2 py-2 text-stone-300" aria-hidden>
              …
            </span>
          );
        }
        const isCurrent = p === currentPage;
        elements.push(
          <Link
            key={p}
            href={buildHref(basePath, searchParams, p)}
            aria-label={`Page ${p}`}
            aria-current={isCurrent ? "page" : undefined}
            className={`px-3 py-2 rounded-lg min-w-[40px] text-center transition-colors ${
              isCurrent ? "bg-navy text-white" : "bg-stone-100 text-stone-900 hover:bg-stone-300"
            }`}
          >
            {p}
          </Link>
        );
        return elements;
      })}
      {currentPage < totalPages && (
        <Link
          href={buildHref(basePath, searchParams, currentPage + 1)}
          rel="next"
          aria-label="Next page"
          className="px-3 py-2 rounded-lg bg-stone-100 text-stone-900 hover:bg-stone-300 transition-colors"
        >
          &raquo;
        </Link>
      )}
    </nav>
  );
}
