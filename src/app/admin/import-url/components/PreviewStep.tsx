import {
  Calendar,
  Clock,
  MapPin,
  DollarSign,
  ExternalLink,
  Check,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExtractedEventData, ExtractedEvent, VenueOption } from "@/lib/url-import/types";
import type { Venue } from "../use-import-wizard";
import { formatDateForDisplay, formatTimeForDisplay } from "../utils";

interface PreviewStepProps {
  eventsToImport: ExtractedEvent[];
  extractedData: ExtractedEventData;
  venueOption: VenueOption;
  venues: Venue[];
  datesConfirmed: boolean;
  url: string;
  onBack: () => void;
  onSave: () => void;
}

export function PreviewStep({
  eventsToImport,
  extractedData,
  venueOption,
  venues,
  datesConfirmed,
  url,
  onBack,
  onSave,
}: PreviewStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {eventsToImport.length > 1
            ? `Preview ${eventsToImport.length} Events`
            : "Final Preview"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Multi-event preview list */}
        {eventsToImport.length > 1 ? (
          <div className="space-y-4 mb-6">
            {eventsToImport.map((event, index) => (
              <div
                key={event._extractId}
                className="border rounded-lg p-4 flex gap-4"
              >
                {event.imageUrl && (
                  <div className="w-24 h-16 rounded overflow-hidden flex-shrink-0 bg-gray-100">
                    <img
                      src={event.imageUrl}
                      alt={event.name || "Event"}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-gray-900 truncate">
                    {index + 1}. {event.name}
                  </h3>
                  <div className="flex items-center text-sm text-gray-600 mt-1">
                    <Calendar className="w-3 h-3 mr-1" />
                    {formatDateForDisplay(event.startDate)}
                    {event.endDate && event.endDate !== event.startDate && (
                      <> - {formatDateForDisplay(event.endDate)}</>
                    )}
                  </div>
                  {(event.startTime || event.endTime) && (
                    <div className="flex items-center text-sm text-gray-600 mt-1">
                      <Clock className="w-3 h-3 mr-1" />
                      {formatTimeForDisplay(event.startTime)}
                      {event.endTime && (
                        <> - {formatTimeForDisplay(event.endTime)}</>
                      )}
                    </div>
                  )}
                  {event.venueName && (
                    <div className="flex items-center text-sm text-gray-600 mt-1">
                      <MapPin className="w-3 h-3 mr-1" />
                      {event.venueName}
                      {event.venueCity && `, ${event.venueCity}`}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Source */}
            {url && (
              <SourceLink url={url} />
            )}
          </div>
        ) : (
          /* Single event preview card */
          <div className="border rounded-lg overflow-hidden mb-6">
            {/* Image */}
            {extractedData.imageUrl && (
              <div className="aspect-video relative bg-gray-100">
                <img
                  src={extractedData.imageUrl}
                  alt={extractedData.name || "Event"}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            )}

            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                {extractedData.name}
              </h2>

              {/* Dates */}
              <div className="flex items-center text-gray-600 mb-2">
                <Calendar className="w-4 h-4 mr-2" />
                <span>
                  {formatDateForDisplay(extractedData.startDate)}
                  {extractedData.endDate &&
                    extractedData.endDate !== extractedData.startDate && (
                      <> - {formatDateForDisplay(extractedData.endDate)}</>
                    )}
                </span>
                {!datesConfirmed && (
                  <span className="ml-2 text-xs text-orange-600">
                    (Tentative)
                  </span>
                )}
              </div>

              {/* Times */}
              {(extractedData.startTime || extractedData.endTime) && (
                <div className="flex items-center text-gray-600 mb-2">
                  <Clock className="w-4 h-4 mr-2" />
                  <span>
                    {formatTimeForDisplay(extractedData.startTime)}
                    {extractedData.endTime && (
                      <> - {formatTimeForDisplay(extractedData.endTime)}</>
                    )}
                  </span>
                  {extractedData.hoursVaryByDay && (
                    <span className="ml-2 text-xs text-orange-600">
                      (Hours vary by day)
                    </span>
                  )}
                </div>
              )}

              {/* Venue */}
              {(venueOption.type === "existing" ||
                venueOption.type === "new") && (
                <div className="flex items-center text-gray-600 mb-2">
                  <MapPin className="w-4 h-4 mr-2" />
                  {venueOption.type === "existing"
                    ? venues.find((v) => v.id === venueOption.id)?.name
                    : venueOption.name}
                </div>
              )}

              {/* Price */}
              {(extractedData.ticketPriceMin !== null ||
                extractedData.ticketPriceMax !== null) && (
                <div className="flex items-center text-gray-600 mb-2">
                  <DollarSign className="w-4 h-4 mr-2" />
                  {extractedData.ticketPriceMin !== null &&
                  extractedData.ticketPriceMax !== null &&
                  extractedData.ticketPriceMin !== extractedData.ticketPriceMax
                    ? `$${extractedData.ticketPriceMin} - $${extractedData.ticketPriceMax}`
                    : `$${extractedData.ticketPriceMin ?? extractedData.ticketPriceMax}`}
                </div>
              )}

              {/* Description */}
              {extractedData.description && (
                <p className="text-gray-700 mt-4 text-sm">
                  {extractedData.description}
                </p>
              )}

              {/* Source */}
              {url && (
                <div className="mt-4 pt-4 border-t">
                  <SourceLink url={url} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <Button onClick={onSave}>
            <Check className="w-4 h-4 mr-1" />
            {eventsToImport.length > 1
              ? `Import ${eventsToImport.length} Events`
              : "Import Event"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceLink({ url }: { url: string }) {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }
  return (
    <p className="text-xs text-gray-500">
      Source:{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline"
      >
        {hostname}
        <ExternalLink className="w-3 h-3 inline ml-1" />
      </a>
    </p>
  );
}
