"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      isLoading = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      "inline-flex items-center justify-center font-medium rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none";

    // Design System keystone PR 2 (2026-06-07) — token migration.
    // - `primary` is the brand amber CTA; `--primary-foreground` is the
    //   amber-bg-fg pair (UX-R3) which gives 9.7:1 AAA on --primary vs
    //   the prior `text-navy` (5.4:1 AA). Minor pixel diff is intentional
    //   and matches the spec's "UX-R3 closure" goal.
    // - `secondary` (Button variant) stays neutral gray — it's a "secondary
    //   action" button, not a "brand secondary" button. Maps to --muted
    //   tokens, NOT to --secondary (which is the navy brand color, only
    //   used by surfaces that explicitly want navy).
    // - `outline` / `ghost` use surface + content tokens.
    // - `danger` maps to --destructive (the new shadcn-convention name).
    const variants = {
      primary: "bg-primary text-primary-foreground hover:bg-primary/90",
      secondary: "bg-muted text-foreground hover:bg-muted/80",
      outline: "border border-input bg-background text-foreground hover:bg-muted",
      ghost: "text-foreground hover:bg-muted",
      danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    };

    const sizes = {
      sm: "px-3 py-1.5 text-sm",
      md: "px-4 py-2 text-sm",
      lg: "px-6 py-3 text-base",
    };

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin -ml-1 mr-2 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

export { Button };
