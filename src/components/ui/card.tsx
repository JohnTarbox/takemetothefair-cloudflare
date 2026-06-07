import { cn } from "@/lib/utils";

// Design System keystone PR 2 (2026-06-07) — token migration + variant axis.
//
// Variants:
//   - `default` (was: bg-white border-gray-200) → bg-card border-border
//     The "elevated card on the page background" — what 95% of callsites want.
//   - `muted` — bg-muted border-border. Subtle / secondary card surface;
//     consolidates the inline `<div className="bg-gray-50 border rounded p-4">`
//     ad-hoc pattern that recurs across detail pages.
//   - `outlined` — transparent bg, just a border. For empty-state cards.
//
// Compound parts (CardHeader/Title/Content/Footer) inherit the token
// scheme; CardFooter explicitly bg-muted to preserve the prior gray-50
// "footer accent" effect.

type CardVariant = "default" | "muted" | "outlined";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: CardVariant;
}

const CARD_VARIANTS: Record<CardVariant, string> = {
  default: "bg-card text-card-foreground border-border",
  muted: "bg-muted text-foreground border-border",
  outlined: "bg-transparent text-foreground border-border",
};

export function Card({ className, children, variant = "default", ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-xl shadow-sm border overflow-hidden",
        CARD_VARIANTS[variant],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-6 py-4 border-b border-border", className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-lg font-semibold text-foreground", className)} {...props}>
      {children}
    </h3>
  );
}

export function CardContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-6 py-4", className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-6 py-4 bg-muted border-t border-border", className)} {...props}>
      {children}
    </div>
  );
}
