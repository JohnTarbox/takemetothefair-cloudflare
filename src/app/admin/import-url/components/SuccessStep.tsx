import Link from "next/link";
import { Check, AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface SuccessStepProps {
  createdEvents: Array<{ id: string; slug: string; name: string }>;
  batchErrors: Array<{ eventName: string; error: string }>;
  onRetryFailed?: () => void;
  onReset: () => void;
}

export function SuccessStep({ createdEvents, batchErrors, onRetryFailed, onReset }: SuccessStepProps) {
  const hasErrors = batchErrors.length > 0;
  const hasCreated = createdEvents.length > 0;

  return (
    <Card>
      <CardContent className="py-12">
        <div className="text-center">
          <div
            className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
              hasErrors && !hasCreated
                ? "bg-red-100"
                : hasErrors
                ? "bg-yellow-100"
                : "bg-green-100"
            }`}
          >
            {hasErrors && !hasCreated ? (
              <AlertTriangle className="w-8 h-8 text-red-600" />
            ) : hasErrors ? (
              <AlertTriangle className="w-8 h-8 text-yellow-600" />
            ) : (
              <Check className="w-8 h-8 text-green-600" />
            )}
          </div>
          <h3 className="text-xl font-bold text-gray-900 mb-2">
            {hasErrors && !hasCreated
              ? "Import Failed"
              : hasErrors
              ? `${createdEvents.length} of ${createdEvents.length + batchErrors.length} Events Imported`
              : createdEvents.length > 1
              ? `${createdEvents.length} Events Imported Successfully!`
              : "Event Imported Successfully!"}
          </h3>
          <p className="text-gray-600 mb-6">
            {hasErrors && !hasCreated
              ? "All events failed to import. You can retry below."
              : hasErrors
              ? `${batchErrors.length} event${batchErrors.length > 1 ? "s" : ""} failed to import.`
              : createdEvents.length > 1
              ? "All events have been created and are now live."
              : createdEvents[0]?.name
              ? `${createdEvents[0].name} has been created and is now live.`
              : "The event has been created and is now live."}
          </p>
        </div>

        {/* Batch errors */}
        {hasErrors && (
          <div className="max-w-md mx-auto mb-6">
            <h4 className="text-sm font-medium text-red-800 mb-2">Failed Events</h4>
            <div className="space-y-2">
              {batchErrors.map((err, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm"
                >
                  <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-red-900">{err.eventName}</span>
                    <span className="text-red-700">: {err.error}</span>
                  </div>
                </div>
              ))}
            </div>
            {onRetryFailed && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRetryFailed}
                className="mt-3 w-full text-red-700 border-red-300 hover:bg-red-50"
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                Retry Failed ({batchErrors.length})
              </Button>
            )}
          </div>
        )}

        {/* List of created events */}
        {hasCreated && (
          <div className="max-w-md mx-auto mb-6 space-y-2">
            {createdEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <span className="font-medium text-gray-900 truncate flex-1 mr-3">
                  {event.name}
                </span>
                <Link
                  href={`/events/${event.slug}`}
                  target="_blank"
                  className="text-blue-600 hover:text-blue-800 flex-shrink-0"
                >
                  <ExternalLink className="w-4 h-4" />
                </Link>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-center gap-4">
          {createdEvents.length === 1 && createdEvents[0] && (
            <Link href={`/events/${createdEvents[0].slug}`} target="_blank">
              <Button variant="outline">
                View Event
                <ExternalLink className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          )}
          <Button onClick={onReset}>Import Another</Button>
        </div>
      </CardContent>
    </Card>
  );
}
