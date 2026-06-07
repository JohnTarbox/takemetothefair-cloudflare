"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, label, error, id, ...props }, ref) => {
    const inputId = id || props.name;

    // Design System keystone PR 2 (2026-06-07) — token migration.
    // Border, text, placeholder, focus ring, disabled state all on
    // semantic tokens. Error state uses --destructive. Matches Textarea's
    // already-token-backed pattern (placeholder:text-muted-foreground etc.)
    // so input + textarea now look identical at the chrome level.
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-foreground mb-1">
            {label}
          </label>
        )}
        <input
          type={type}
          id={inputId}
          className={cn(
            "block w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground",
            "focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring",
            "disabled:bg-muted disabled:text-muted-foreground",
            error && "border-destructive focus:border-destructive focus:ring-destructive",
            className
          )}
          ref={ref}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";

export { Input };
