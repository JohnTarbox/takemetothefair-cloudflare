import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface SavingStepProps {
  eventsCount: number;
  progress: { current: number; total: number } | null;
}

export function SavingStep({ eventsCount, progress }: SavingStepProps) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
        <h3 className="text-lg font-medium text-gray-900">
          {progress && progress.total > 1
            ? `Saving event ${progress.current} of ${progress.total}...`
            : `Importing ${eventsCount > 1 ? `${eventsCount} events` : "event"}...`}
        </h3>
        <p className="text-gray-500 mt-2">Please wait</p>
        {progress && progress.total > 1 && (
          <div className="mt-4 max-w-xs mx-auto">
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
