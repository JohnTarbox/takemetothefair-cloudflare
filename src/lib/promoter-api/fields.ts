/**
 * OPE-1620 — an API body → the OPE-1618 import row. The CSV template's fields
 * ARE the API's fields (same keys, same parser, same messages), so a value the
 * spreadsheet accepts the API accepts and vice versa.
 *
 * The JSON layer adds only what a spreadsheet cannot express: a wrong type, an
 * unknown key, and the entity decoding every free-text boundary applies
 * (CLAUDE.md). Everything else is `parseRows`.
 */
import { z } from "zod";
import { decodeHtmlEntities } from "@/lib/utils";
import {
  TEMPLATE_COLUMNS,
  parseRows,
  type ImportField,
  type ImportRow,
} from "@/lib/promoter-import/rows";

export interface FieldError {
  field: string | null;
  message: string;
}

export const API_FIELDS = TEMPLATE_COLUMNS.map((c) => c.key);
const FREE_TEXT: ReadonlySet<ImportField> = new Set([
  "name",
  "venue_name",
  "address",
  "city",
  "description",
  "daily_hours",
  "admission",
]);
/**
 * Supplied fields the review diff (diffAgainstEvent) does not compare, so a
 * change to only these on an existing event is reported, not silently lost.
 */
export const NOT_COMPARED_ON_UPDATE: ReadonlySet<ImportField> = new Set([
  "daily_hours",
  "venue_name",
  "address",
  "city",
  "state",
  "zip",
  "categories",
]);

export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:~-]{1,100}$/;
export const externalIdSchema = z
  .string()
  .min(1, "external_id is required.")
  .max(100, "external_id is at most 100 characters.")
  .regex(EXTERNAL_ID_PATTERN, "external_id may use letters, digits and . _ : ~ - only.");

/** A path segment → the external_id (Next may or may not have decoded it already). */
export function decodePathId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const scalar = (field: ImportField) => {
  const str = z.string().max(5000, "At most 5,000 characters.");
  const s = FREE_TEXT.has(field) ? str.transform(decodeHtmlEntities) : str;
  if (field === "categories")
    return z
      .union([s, z.array(z.string().max(100).transform(decodeHtmlEntities)).max(20)], {
        error: "Must be a string or an array of strings.",
      })
      .nullable()
      .optional();
  return z
    .union([s, z.number().finite()], { error: "Must be a string or a number." })
    .nullable()
    .optional();
};

const fieldShape = Object.fromEntries(API_FIELDS.map((k) => [k, scalar(k)])) as Record<
  ImportField,
  ReturnType<typeof scalar>
>;

export const upsertBodySchema = z.strictObject({ external_id: externalIdSchema, ...fieldShape });
export const patchBodySchema = z.strictObject(fieldShape);
export const cancelBodySchema = z.strictObject({
  reason: z.string().max(500, "At most 500 characters.").transform(decodeHtmlEntities).optional(),
});

/** Zod issues → [{field, message}], one per unknown key. */
export function zodFieldErrors(error: z.ZodError): FieldError[] {
  const out: FieldError[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) out.push({ field: k, message: "Unknown field." });
      continue;
    }
    out.push({
      field: issue.path.length ? String(issue.path[0]) : null,
      message: issue.message,
    });
  }
  return out;
}

export type ApiFieldValues = Partial<Record<ImportField, string | number | string[] | null>>;

/** The supplied (non-null) values, as spreadsheet cells. */
export function toCells(values: ApiFieldValues): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {};
  for (const k of API_FIELDS) {
    const v = values[k];
    if (v === null || v === undefined) continue;
    const cell = Array.isArray(v) ? v.join("; ") : String(v);
    if (cell.trim()) out[k] = cell;
  }
  return out;
}

/** Cells → one parsed import row, via the spreadsheet parser itself. */
export function parseApiRow(cells: Partial<Record<ImportField, string>>): {
  row: ImportRow;
  errors: FieldError[];
} {
  const header = TEMPLATE_COLUMNS.map((c) => c.header);
  const values = TEMPLATE_COLUMNS.map((c) => cells[c.key] ?? "");
  const { rows, headerErrors } = parseRows([header, values]);
  if (headerErrors.length || rows.length !== 1)
    // Unreachable with the full template header; kept so a parser change fails loudly.
    throw new Error(`promoter-api: template header refused (${headerErrors.join(" ")})`);
  const row = rows[0];
  return { row, errors: row.fieldErrors.map((e) => ({ field: e.field, message: e.message })) };
}
