import { AlertCircle } from "lucide-react";
import type { FieldErrors } from "@/lib/validations/field-errors";

interface Props {
  /** Map of field name → error message. Pass an empty object to hide the banner. */
  errors: FieldErrors;
  /** Map field names to human-readable labels for the summary list. */
  fieldLabels?: Record<string, string>;
  /** Heading copy; defaults to "Please fix the following before submitting". */
  title?: string;
}

/**
 * Renders a single banner listing every field-level error with anchor links
 * that scroll + focus the corresponding input (matched by id or name).
 *
 * The anchor handler is a click-to-scroll fallback; plain hash links would
 * work too, but clicking then tends to jump slightly past the field.
 */
export function FormErrorSummary({ errors, fieldLabels, title }: Props) {
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-red-700">
            {title ?? "Please fix the following before submitting"}
          </p>
          <ul className="mt-1 space-y-0.5 text-red-700 list-disc ml-5">
            {entries.map(([field, message]) => {
              const label = fieldLabels?.[field] ?? field;
              return (
                <li key={field}>
                  <a
                    href={`#${field}`}
                    onClick={(e) => {
                      e.preventDefault();
                      const el =
                        (document.getElementById(field) as HTMLElement | null) ||
                        (document.querySelector(`[name="${field}"]`) as HTMLElement | null);
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        el.focus?.();
                      }
                    }}
                    className="underline hover:no-underline"
                  >
                    <strong className="font-medium">{label}:</strong> {message}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
