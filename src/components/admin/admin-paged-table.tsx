"use client";

/**
 * OPE-1595 — the one paged, searchable admin table.
 *
 * The URL holds every view setting, so a filtered page is linkable. Updates go
 * through `history.replaceState`, which Next feeds back into `useSearchParams`
 * without a server round trip for each keystroke.
 */
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  SortableHeader,
  type SortConfig,
  getNextSortDirection,
} from "@/components/ui/sortable-table";
import { pluralize } from "@/lib/text";

export interface PagedResponse<Row> {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  stats?: Record<string, number>;
}

export interface RowContext {
  reload: () => void;
}

export interface AdminColumn<Row> {
  key: string;
  label: string;
  /** Server sort key. Omit for a column that cannot be sorted. */
  sortKey?: string;
  align?: "right";
  cell: (row: Row, ctx: RowContext) => ReactNode;
}

export interface AdminFilter {
  param: string;
  allLabel: string;
  title?: string;
  options: { value: string; label: string }[];
}

interface Props<Row> {
  endpoint: string;
  columns: AdminColumn<Row>[];
  rowKey: (row: Row) => string;
  noun: string;
  searchPlaceholder: string;
  filters?: AdminFilter[];
  defaultSort: { column: string; direction: "asc" | "desc" };
  onData?: (data: PagedResponse<Row>) => void;
  /** Bump to refetch after a change made outside the table. */
  refreshKey?: number;
}

const PAGE_SIZES = [25, 50, 100];
const SEARCH_DEBOUNCE_MS = 300;

function Skeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 bg-muted rounded w-1/4"></div>
      <div className="h-64 bg-muted rounded"></div>
    </div>
  );
}

function PagedTable<Row>({
  endpoint,
  columns,
  rowKey,
  noun,
  searchPlaceholder,
  filters = [],
  defaultSort,
  onData,
  refreshKey = 0,
}: Props<Row>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();

  const [data, setData] = useState<PagedResponse<Row> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const onDataRef = useRef(onData);
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  const writeParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(window.location.search);
      mutate(params);
      const next = params.toString();
      window.history.replaceState(null, "", next ? `${pathname}?${next}` : pathname);
    },
    [pathname]
  );

  const setFilter = (param: string, value: string) =>
    writeParams((params) => {
      if (value) params.set(param, value);
      else params.delete(param);
      params.delete("page");
    });

  const q = searchParams.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(q);
  const lastWrittenQ = useRef(q);
  useEffect(() => {
    // Only an outside change (back button, pasted link) may overwrite the box;
    // the echo of our own debounced write must not eat newer keystrokes.
    if (q !== lastWrittenQ.current) {
      lastWrittenQ.current = q;
      setSearchInput(q);
    }
  }, [q]);
  useEffect(() => {
    if (searchInput === lastWrittenQ.current) return;
    const handle = setTimeout(() => {
      lastWrittenQ.current = searchInput;
      writeParams((params) => {
        if (searchInput) params.set("q", searchInput);
        else params.delete("q");
        params.delete("page");
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput, writeParams]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(qs);
    if (!params.has("page")) params.set("page", "1");
    setFetching(true);
    setError(null);
    fetch(`${endpoint}?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as PagedResponse<Row> & { error?: string };
        if (!res.ok || !Array.isArray(body.rows)) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      })
      .then((body) => {
        setData(body);
        onDataRef.current?.(body);
        setFetching(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Request failed");
        setFetching(false);
      });
    return () => controller.abort();
  }, [endpoint, qs, tick, refreshKey]);

  const page = Number(searchParams.get("page")) || 1;
  const pageSize = data?.pageSize ?? (Number(searchParams.get("pageSize")) || 50);
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  // Deleting the last row of the last page must not strand the view on an
  // empty page past the end.
  useEffect(() => {
    if (data && !fetching && page > lastPage) {
      writeParams((params) => {
        params.set("page", String(lastPage));
      });
    }
  }, [data, fetching, page, lastPage, writeParams]);

  const sortParam = searchParams.get("sort");
  const sortConfig: SortConfig = sortParam
    ? { column: sortParam, direction: searchParams.get("dir") === "desc" ? "desc" : "asc" }
    : defaultSort;

  const handleSort = (column: string) => {
    const next = getNextSortDirection(sortConfig, column);
    writeParams((params) => {
      if (next.column && next.direction) {
        params.set("sort", next.column);
        params.set("dir", next.direction);
      } else {
        params.delete("sort");
        params.delete("dir");
      }
      params.delete("page");
    });
  };

  const goToPage = (target: number) =>
    writeParams((params) => {
      if (target > 1) params.set("page", String(target));
      else params.delete("page");
    });

  const activeFilters = filters.some((f) => searchParams.get(f.param));
  const clearFilters = () =>
    writeParams((params) => {
      for (const f of filters) params.delete(f.param);
      params.delete("page");
    });

  const csvParams = new URLSearchParams(qs);
  csvParams.set("format", "csv");
  csvParams.delete("page");
  csvParams.delete("pageSize");

  const ctx: RowContext = { reload };
  const narrowed = Boolean(q) || activeFilters;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            className="pl-8"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
        </div>
        {filters.map((f) => (
          <select
            key={f.param}
            value={searchParams.get(f.param) ?? ""}
            onChange={(e) => setFilter(f.param, e.target.value)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground bg-card"
            title={f.title}
            aria-label={f.title ?? f.allLabel}
          >
            <option value="">{f.allLabel}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        {activeFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-sm text-royal hover:underline"
          >
            Clear filters
          </button>
        )}
        <a
          href={`${endpoint}?${csvParams.toString()}`}
          download
          className="ml-auto inline-flex items-center gap-1 text-sm text-royal hover:underline"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </a>
      </div>

      {data === null && !error ? (
        <Skeleton />
      ) : (
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">
              {data ? `${pluralize(data.total, noun)} ${narrowed ? "match" : "total"}` : ""}
            </p>
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="py-6 text-sm text-red-700">
                Couldn&apos;t load this list: {error}.{" "}
                <button type="button" onClick={reload} className="text-royal hover:underline">
                  Retry
                </button>
              </div>
            ) : (
              <div className={`overflow-x-auto ${fetching ? "opacity-60" : ""}`}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {columns.map((c) =>
                        c.sortKey ? (
                          <SortableHeader
                            key={c.key}
                            column={c.sortKey}
                            label={c.label}
                            sortConfig={sortConfig}
                            onSort={handleSort}
                          />
                        ) : (
                          <th
                            key={c.key}
                            className={`${c.align === "right" ? "text-right" : "text-left"} py-3 px-4 text-sm font-medium text-muted-foreground`}
                          >
                            {c.label}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data?.rows.map((row) => (
                      <tr key={rowKey(row)} className="border-b border-border">
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className={`py-3 px-4 ${c.align === "right" ? "text-right" : ""}`}
                          >
                            {c.cell(row, ctx)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {data?.rows.length === 0 && (
                      <tr>
                        <td
                          colSpan={columns.length}
                          className="py-8 text-center text-sm text-muted-foreground"
                        >
                          Nothing matches.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <label className="text-sm text-muted-foreground">
                Rows per page{" "}
                <select
                  value={pageSize}
                  onChange={(e) =>
                    writeParams((params) => {
                      params.set("pageSize", e.target.value);
                      params.delete("page");
                    })
                  }
                  className="ml-1 rounded-md border border-border px-2 py-1 text-sm text-foreground bg-card"
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {Math.min(page, lastPage)} of {lastPage}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= lastPage}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** `useSearchParams` needs a Suspense boundary during the prerender. */
export function AdminPagedTable<Row>(props: Props<Row>) {
  return (
    <Suspense fallback={<Skeleton />}>
      <PagedTable {...props} />
    </Suspense>
  );
}
