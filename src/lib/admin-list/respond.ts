import { NextResponse } from "next/server";
import { isCsvRequest, parseListParams, toCsv, type CsvColumn } from "./params";
import { runCsvRows, runList, type ListSpec } from "./run-list";

export interface AdminList<Row extends { id: string }> {
  name: string;
  spec: ListSpec<Row>;
  csv: CsvColumn<Row>[];
}

export function csvResponse(name: string, body: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
    },
  });
}

/** Answers a paged or CSV request for one admin list. */
export async function respondWithList<Row extends { id: string }>(
  list: AdminList<Row>,
  searchParams: URLSearchParams
): Promise<NextResponse> {
  const params = parseListParams(searchParams);
  if (isCsvRequest(searchParams)) {
    return csvResponse(list.name, toCsv(list.csv, await runCsvRows(list.spec, params)));
  }
  return NextResponse.json(await runList(list.spec, params));
}
