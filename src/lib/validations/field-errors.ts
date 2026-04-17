import type { ZodSchema, ZodError } from "zod";

export type FieldErrors = Record<string, string>;

/**
 * Flatten a zod error into a { field → message } map, keyed by the first path
 * segment (which is the form field name for flat object schemas).
 */
export function zodIssuesToFieldErrors(err: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of err.issues) {
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Validate a full form object against a zod schema.
 *
 * Returns { ok: true, data } on success, or { ok: false, errors } with a map
 * of field → error message on failure.
 */
export function validateAll<T>(
  schema: ZodSchema<T>,
  values: unknown
): { ok: true; data: T } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: zodIssuesToFieldErrors(result.error) };
}

/**
 * Validate a single field against a zod schema by extracting just that field
 * from the provided values. Useful for onBlur handlers.
 *
 * Falls back gracefully to the full-schema check if the schema isn't a
 * ZodObject (e.g. a refined/extended schema).
 */
export function validateField<T>(
  schema: ZodSchema<T>,
  field: string,
  values: Record<string, unknown>
): string | null {
  const result = schema.safeParse(values);
  if (result.success) return null;
  for (const issue of result.error.issues) {
    if (issue.path[0] === field) return issue.message;
  }
  return null;
}
