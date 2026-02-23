import { Calendar, MapPin, ChevronRight, ChevronLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExtractedEvent } from "@/lib/url-import/types";
import { formatDateForDisplay } from "../utils";

interface SelectEventsStepProps {
  extractedEvents: ExtractedEvent[];
  selectedEventIds: Set<string>;
  onToggleEvent: (eventId: string) => void;
  onToggleSelectAll: () => void;
  onProceedToReview: () => void;
  onBack: () => void;
}

export function SelectEventsStep({
  extractedEvents,
  selectedEventIds,
  onToggleEvent,
  onToggleSelectAll,
  onProceedToReview,
  onBack,
}: SelectEventsStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-600" />
          {extractedEvents.length} Events Found
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          Select the events you want to import. You&apos;ll be able to review
          and edit each one before saving.
        </p>

        {/* Select All / Deselect All */}
        <div className="flex items-center gap-4 pb-3 border-b">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={selectedEventIds.size === extractedEvents.length}
              onChange={onToggleSelectAll}
              className="rounded border-gray-300"
            />
            <span className="font-medium">
              {selectedEventIds.size === extractedEvents.length
                ? "Deselect All"
                : "Select All"}
            </span>
          </label>
          <span className="text-sm text-gray-500">
            {selectedEventIds.size} of {extractedEvents.length} selected
          </span>
        </div>

        {/* Event List */}
        <div className="space-y-3 max-h-[500px] overflow-y-auto">
          {extractedEvents.map((event) => (
            <label
              key={event._extractId}
              className={`flex items-start p-4 border rounded-lg cursor-pointer transition-colors ${
                selectedEventIds.has(event._extractId)
                  ? "border-blue-500 bg-blue-50"
                  : "hover:bg-gray-50"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedEventIds.has(event._extractId)}
                onChange={() => onToggleEvent(event._extractId)}
                className="mt-1 rounded border-gray-300"
              />
              <div className="ml-3 flex-1">
                <div className="font-medium text-gray-900">
                  {event.name || "Unnamed Event"}
                </div>
                {event.startDate && (
                  <div className="flex items-center text-sm text-gray-600 mt-1">
                    <Calendar className="w-3 h-3 mr-1" />
                    {formatDateForDisplay(event.startDate)}
                    {event.endDate && event.endDate !== event.startDate && (
                      <> - {formatDateForDisplay(event.endDate)}</>
                    )}
                  </div>
                )}
                {(event.venueName || event.venueCity) && (
                  <div className="flex items-center text-sm text-gray-600 mt-1">
                    <MapPin className="w-3 h-3 mr-1" />
                    {event.venueName}
                    {event.venueCity && `, ${event.venueCity}`}
                    {event.venueState && `, ${event.venueState}`}
                  </div>
                )}
                {event.description && (
                  <p className="text-sm text-gray-500 mt-2 line-clamp-2">
                    {event.description}
                  </p>
                )}
              </div>
            </label>
          ))}
        </div>

        {/* Navigation */}
        <div className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <Button
            onClick={onProceedToReview}
            disabled={selectedEventIds.size === 0}
          >
            Review Selected Events ({selectedEventIds.size})
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
