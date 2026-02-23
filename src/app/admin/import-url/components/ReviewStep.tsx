import {
  Sparkles,
  RefreshCw,
  MapPin,
  DollarSign,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfidenceBadge } from "@/components/ui/confidence-badge";
import type { ExtractedEventData, FieldConfidence, ExtractedEvent } from "@/lib/url-import/types";

interface ReviewStepProps {
  fetchedContent: string;
  extractedData: ExtractedEventData;
  confidence: FieldConfidence;
  datesConfirmed: boolean;
  eventsToImport: ExtractedEvent[];
  currentEventIndex: number;
  extractedEventsCount: number;
  onUpdateData: (data: Partial<ExtractedEventData>) => void;
  onSetDatesConfirmed: (confirmed: boolean) => void;
  onGoToPreviousEvent: () => void;
  onGoToNextEvent: () => void;
  onGoToVenue: () => void;
  onReExtract?: () => void;
}

export function ReviewStep({
  fetchedContent,
  extractedData,
  confidence,
  datesConfirmed,
  eventsToImport,
  currentEventIndex,
  extractedEventsCount,
  onUpdateData,
  onSetDatesConfirmed,
  onGoToPreviousEvent,
  onGoToNextEvent,
  onGoToVenue,
  onReExtract,
}: ReviewStepProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Left: Source Content */}
      <div className="lg:col-span-2">
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="text-sm">Source Content</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-[600px] overflow-y-auto text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 p-3 rounded-lg">
              {fetchedContent || "No content available"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right: Editable Form */}
      <div className="lg:col-span-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                {eventsToImport.length > 1
                  ? `Event ${currentEventIndex + 1} of ${eventsToImport.length}`
                  : "Event Details"}
              </span>
              <div className="flex items-center gap-2">
                {eventsToImport.length > 1 && (
                  <span className="text-sm font-normal text-gray-500">
                    Review and edit each event
                  </span>
                )}
                {onReExtract && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onReExtract}
                    className="text-xs"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Re-extract
                  </Button>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Event Name */}
            <div>
              <Label htmlFor="name">
                Event Name *
                <ConfidenceBadge field="name" confidence={confidence} />
              </Label>
              <Input
                id="name"
                value={extractedData.name || ""}
                onChange={(e) => onUpdateData({ name: e.target.value })}
                className="mt-1"
              />
            </div>

            {/* Description */}
            <div>
              <Label htmlFor="description">
                Description
                <ConfidenceBadge field="description" confidence={confidence} />
              </Label>
              <textarea
                id="description"
                className="mt-1 w-full h-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={extractedData.description || ""}
                onChange={(e) =>
                  onUpdateData({ description: e.target.value })
                }
              />
            </div>

            {/* Dates */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="startDate">
                  Start Date
                  <ConfidenceBadge field="startDate" confidence={confidence} />
                </Label>
                <Input
                  id="startDate"
                  type="date"
                  value={extractedData.startDate?.substring(0, 10) || ""}
                  onChange={(e) =>
                    onUpdateData({ startDate: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="endDate">
                  End Date
                  <ConfidenceBadge field="endDate" confidence={confidence} />
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={extractedData.endDate?.substring(0, 10) || ""}
                  onChange={(e) =>
                    onUpdateData({ endDate: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={datesConfirmed}
                onChange={(e) => onSetDatesConfirmed(e.target.checked)}
                className="rounded border-gray-300"
              />
              Dates are confirmed
            </label>

            {/* Times / Hours */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="startTime">
                  Start Time
                  <ConfidenceBadge field="startTime" confidence={confidence} />
                </Label>
                <Input
                  id="startTime"
                  type="time"
                  value={extractedData.startTime || ""}
                  onChange={(e) =>
                    onUpdateData({ startTime: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="endTime">
                  End Time
                  <ConfidenceBadge field="endTime" confidence={confidence} />
                </Label>
                <Input
                  id="endTime"
                  type="time"
                  value={extractedData.endTime || ""}
                  onChange={(e) =>
                    onUpdateData({ endTime: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={extractedData.hoursVaryByDay}
                onChange={(e) =>
                  onUpdateData({ hoursVaryByDay: e.target.checked })
                }
                className="rounded border-gray-300"
              />
              Hours vary by day
            </label>

            {(extractedData.hoursVaryByDay || extractedData.hoursNotes) && (
              <div>
                <Label htmlFor="hoursNotes">
                  Hours Notes
                  <ConfidenceBadge field="hoursNotes" confidence={confidence} />
                </Label>
                <textarea
                  id="hoursNotes"
                  className="mt-1 w-full h-16 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  placeholder="e.g., Fri 5-9pm, Sat 10am-6pm, Sun 10am-4pm"
                  value={extractedData.hoursNotes || ""}
                  onChange={(e) =>
                    onUpdateData({ hoursNotes: e.target.value || null })
                  }
                />
              </div>
            )}

            {/* Ticket Info */}
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-1">
                <Label htmlFor="ticketPriceMin">
                  Min Price
                  <ConfidenceBadge field="ticketPriceMin" confidence={confidence} />
                </Label>
                <div className="relative mt-1">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <Input
                    id="ticketPriceMin"
                    type="number"
                    min="0"
                    step="0.01"
                    value={extractedData.ticketPriceMin ?? ""}
                    onChange={(e) =>
                      onUpdateData({
                        ticketPriceMin: e.target.value
                          ? parseFloat(e.target.value)
                          : null,
                      })
                    }
                    className="pl-8"
                  />
                </div>
              </div>
              <div className="col-span-1">
                <Label htmlFor="ticketPriceMax">
                  Max Price
                  <ConfidenceBadge field="ticketPriceMax" confidence={confidence} />
                </Label>
                <div className="relative mt-1">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <Input
                    id="ticketPriceMax"
                    type="number"
                    min="0"
                    step="0.01"
                    value={extractedData.ticketPriceMax ?? ""}
                    onChange={(e) =>
                      onUpdateData({
                        ticketPriceMax: e.target.value
                          ? parseFloat(e.target.value)
                          : null,
                      })
                    }
                    className="pl-8"
                  />
                </div>
              </div>
              <div className="col-span-1">
                <Label htmlFor="ticketUrl">
                  Ticket URL
                  <ConfidenceBadge field="ticketUrl" confidence={confidence} />
                </Label>
                <Input
                  id="ticketUrl"
                  type="url"
                  value={extractedData.ticketUrl || ""}
                  onChange={(e) =>
                    onUpdateData({ ticketUrl: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
            </div>

            {/* Image URL */}
            <div>
              <Label htmlFor="imageUrl">
                Image URL
                <ConfidenceBadge field="imageUrl" confidence={confidence} />
              </Label>
              <div className="flex gap-2 mt-1">
                <Input
                  id="imageUrl"
                  type="url"
                  value={extractedData.imageUrl || ""}
                  onChange={(e) =>
                    onUpdateData({ imageUrl: e.target.value || null })
                  }
                  className="flex-1"
                />
                {extractedData.imageUrl && (
                  <div className="w-16 h-10 rounded border overflow-hidden flex-shrink-0">
                    <img
                      src={extractedData.imageUrl}
                      alt="Preview"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Venue Info (extracted) */}
            <div className="border-t pt-4 mt-4">
              <Label className="flex items-center gap-2 mb-3">
                <MapPin className="w-4 h-4" />
                Venue Information (AI Extracted)
              </Label>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="venueName">
                    Venue Name
                    <ConfidenceBadge field="venueName" confidence={confidence} />
                  </Label>
                  <Input
                    id="venueName"
                    value={extractedData.venueName || ""}
                    onChange={(e) =>
                      onUpdateData({ venueName: e.target.value || null })
                    }
                    placeholder="e.g., Fairgrounds, Convention Center"
                    className="mt-1"
                  />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="venueAddress">
                    Street Address
                    <ConfidenceBadge field="venueAddress" confidence={confidence} />
                  </Label>
                  <Input
                    id="venueAddress"
                    value={extractedData.venueAddress || ""}
                    onChange={(e) =>
                      onUpdateData({ venueAddress: e.target.value || null })
                    }
                    placeholder="e.g., 123 Main Street"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="venueCity">
                    City
                    <ConfidenceBadge field="venueCity" confidence={confidence} />
                  </Label>
                  <Input
                    id="venueCity"
                    value={extractedData.venueCity || ""}
                    onChange={(e) =>
                      onUpdateData({ venueCity: e.target.value || null })
                    }
                    placeholder="e.g., Portland"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="venueState">
                    State
                    <ConfidenceBadge field="venueState" confidence={confidence} />
                  </Label>
                  <Input
                    id="venueState"
                    value={extractedData.venueState || ""}
                    onChange={(e) =>
                      onUpdateData({ venueState: e.target.value || null })
                    }
                    placeholder="e.g., ME"
                    maxLength={2}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Navigation */}
            <div className="flex justify-between pt-4 border-t">
              <Button variant="outline" onClick={onGoToPreviousEvent}>
                <ChevronLeft className="w-4 h-4 mr-1" />
                {currentEventIndex > 0
                  ? "Previous Event"
                  : extractedEventsCount > 1
                  ? "Back to Selection"
                  : "Back"}
              </Button>
              {eventsToImport.length > 1 ? (
                <Button onClick={onGoToNextEvent}>
                  {currentEventIndex < eventsToImport.length - 1
                    ? "Next Event"
                    : "Continue to Promoter"}
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              ) : (
                <Button onClick={onGoToVenue}>
                  Continue to Venue
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
