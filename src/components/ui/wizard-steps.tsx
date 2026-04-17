import { Check } from "lucide-react";

export interface WizardStep {
  key: string;
  label: string;
}

interface Props {
  steps: WizardStep[];
  /** Zero-based index of the current (in-progress) step. */
  currentIndex: number;
  /** Optional click handler — receives the clicked step index. Only enabled for steps ≤ currentIndex. */
  onStepClick?: (index: number) => void;
}

/**
 * Horizontal progress indicator for multi-step wizards.
 *
 * - Step before current → "done" (filled check mark)
 * - Current step        → "active" (numbered, emphasized)
 * - Step after current  → "upcoming" (muted, not clickable)
 *
 * Connectors between steps fill when the next step is done/active.
 */
export function WizardSteps({ steps, currentIndex, onStepClick }: Props) {
  return (
    <nav aria-label="Progress" className="mb-8">
      <ol className="flex items-center gap-1 sm:gap-2">
        {steps.map((step, idx) => {
          const isDone = idx < currentIndex;
          const isActive = idx === currentIndex;
          const clickable = !!onStepClick && idx <= currentIndex;

          const circleBase =
            "flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold flex-shrink-0 transition-colors";
          const circleStyle = isDone
            ? "bg-sage-700 text-white"
            : isActive
              ? "bg-navy text-white"
              : "bg-stone-100 text-stone-600";
          const labelStyle = isActive
            ? "text-navy font-semibold"
            : isDone
              ? "text-stone-900"
              : "text-stone-600";

          const content = (
            <>
              <span className={`${circleBase} ${circleStyle}`} aria-hidden>
                {isDone ? <Check className="w-4 h-4" /> : idx + 1}
              </span>
              <span className={`ml-2 text-sm ${labelStyle} hidden sm:inline`}>{step.label}</span>
            </>
          );

          return (
            <li key={step.key} className="flex items-center flex-1 last:flex-none">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick?.(idx)}
                  className="flex items-center hover:opacity-80 transition-opacity"
                  aria-current={isActive ? "step" : undefined}
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-center" aria-current={isActive ? "step" : undefined}>
                  {content}
                </div>
              )}
              {idx < steps.length - 1 && (
                <div
                  className={`mx-2 sm:mx-3 flex-1 h-0.5 ${idx < currentIndex ? "bg-sage-700" : "bg-stone-100"}`}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
