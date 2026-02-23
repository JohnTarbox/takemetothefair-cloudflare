import { ChevronRight, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { Promoter } from "../use-import-wizard";

interface PromoterStepProps {
  promoters: Promoter[];
  selectedPromoterId: string;
  eventsCount: number;
  onSelectPromoter: (id: string) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function PromoterStep({
  promoters,
  selectedPromoterId,
  eventsCount,
  onSelectPromoter,
  onBack,
  onContinue,
}: PromoterStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Promoter</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {eventsCount > 1 && (
          <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
            You are importing <strong>{eventsCount} events</strong>. All events
            will be assigned to the selected promoter.
          </div>
        )}

        <div>
          <Label htmlFor="promoterId">Promoter *</Label>
          <select
            id="promoterId"
            value={selectedPromoterId}
            onChange={(e) => onSelectPromoter(e.target.value)}
            className="mt-1 w-full h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Select a promoter...</option>
            {promoters.map((promoter) => (
              <option key={promoter.id} value={promoter.id}>
                {promoter.companyName}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {eventsCount > 1
              ? "All events will be assigned to this promoter."
              : "The event will be assigned to this promoter."}
          </p>
        </div>

        {/* Navigation */}
        <div className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <Button onClick={onContinue}>
            {eventsCount > 1
              ? `Preview ${eventsCount} Events`
              : "Preview Event"}
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
