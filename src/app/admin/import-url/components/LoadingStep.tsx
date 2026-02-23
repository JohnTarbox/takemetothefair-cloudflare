import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface LoadingStepProps {
  variant: "fetching" | "extracting";
  onCancel?: () => void;
}

export function LoadingStep({ variant, onCancel }: LoadingStepProps) {
  if (variant === "fetching") {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
          <h3 className="text-lg font-medium text-gray-900">
            Fetching page content...
          </h3>
          <p className="text-gray-500 mt-2">This may take a few seconds</p>
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel} className="mt-4">
              Cancel
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Sparkles className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-pulse" />
        <h3 className="text-lg font-medium text-gray-900">
          Analyzing page content...
        </h3>
        <p className="text-gray-500 mt-2">AI is extracting event details</p>
        {onCancel && (
          <Button variant="outline" size="sm" onClick={onCancel} className="mt-4">
            Cancel
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
