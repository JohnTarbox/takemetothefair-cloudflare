import type { WizardStep } from "../use-import-wizard";

const STEPS: Array<{ key: WizardStep | WizardStep[]; label: string }> = [
  { key: "url-input", label: "URL" },
  { key: ["fetching", "extracting"], label: "Extract" },
  { key: "select-events", label: "Select" },
  { key: "review", label: "Review" },
  { key: "venue", label: "Venue" },
  { key: "promoter", label: "Promoter" },
  { key: "preview", label: "Preview" },
  { key: ["saving", "success"], label: "Done" },
];

export function StepIndicator({ currentStep }: { currentStep: WizardStep }) {
  const currentIndex = STEPS.findIndex((s) =>
    Array.isArray(s.key) ? s.key.includes(currentStep) : s.key === currentStep
  );

  return (
    <div className="flex items-center gap-1 mb-6 overflow-x-auto">
      {STEPS.map((step, i) => {
        const isActive = i === currentIndex;
        const isCompleted = i < currentIndex;
        return (
          <div key={step.label} className="flex items-center">
            {i > 0 && (
              <div
                className={`w-4 h-px mx-1 ${
                  isCompleted ? "bg-blue-500" : "bg-gray-300"
                }`}
              />
            )}
            <span
              className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${
                isActive
                  ? "bg-blue-100 text-blue-700 font-medium"
                  : isCompleted
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
