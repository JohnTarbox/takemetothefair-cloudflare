"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, id, options, ...props }, ref) => {
    const selectId = id || props.name;

    // Design System keystone PR 2 (2026-06-07) — token migration. Mirrors
    // Input's token chrome so Input + Select render identically; both
    // also now match Textarea's pre-existing token classes for consistency.
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={selectId} className="block text-sm font-medium text-foreground mb-1">
            {label}
          </label>
        )}
        <select
          id={selectId}
          className={cn(
            "block w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground",
            "focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring",
            "disabled:bg-muted disabled:text-muted-foreground",
            error && "border-destructive focus:border-destructive focus:ring-destructive",
            className
          )}
          ref={ref}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
      </div>
    );
  }
);

Select.displayName = "Select";

export { Select };
