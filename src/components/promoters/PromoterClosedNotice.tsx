import Link from "next/link";

/**
 * OPE-979 — "No longer operating", John-approved copy (2026-09-30).
 *
 * The source URL and check date behind the status stay admin-only; the public
 * page says what a reader needs and where to go next.
 */
export function PromoterClosedNotice({
  companyName,
  successor,
}: {
  companyName: string;
  successor: { companyName: string; slug: string } | null;
}) {
  return (
    <div
      role="status"
      className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="font-semibold">No longer operating</p>
      {successor ? (
        <>
          <p className="mt-1">
            {companyName} has closed. Its shows are now run by{" "}
            <strong>{successor.companyName}</strong>.
          </p>
          <p className="mt-2">
            <Link href={`/promoters/${successor.slug}`} className="font-medium underline">
              See {successor.companyName}&rsquo;s upcoming shows →
            </Link>
          </p>
        </>
      ) : (
        <p className="mt-1">
          {companyName} is no longer operating. Past events are listed below for reference.
        </p>
      )}
    </div>
  );
}
