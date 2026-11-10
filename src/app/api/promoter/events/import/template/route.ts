/** OPE-1618 — the season template, as CSV (opens in Excel / Sheets / Numbers). Public: it holds no data. */
import { templateCsv } from "@/lib/promoter-import/rows";

export const dynamic = "force-static";

export function GET() {
  return new Response(templateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="meetmeatthefair-season-template.csv"',
    },
  });
}
