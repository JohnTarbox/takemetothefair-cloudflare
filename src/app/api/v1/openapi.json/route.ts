/**
 * OPE-1620 — the promoter API's OpenAPI 3.1 document (src/lib/promoter-api/openapi.ts).
 * Public and static; anyone may read the contract.
 */
import { NextResponse } from "next/server";
import { PROMOTER_API_OPENAPI } from "@/lib/promoter-api/openapi";

export function GET() {
  return NextResponse.json(PROMOTER_API_OPENAPI, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
