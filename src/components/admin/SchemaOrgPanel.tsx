"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Check, AlertCircle, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EventSchemaOrg } from "@/lib/db/schema";

interface EventData {
  id: string;
  name: string;
  description: string | null;
  ticketUrl: string | null;
  startDate: Date | null;
  endDate: Date | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
  imageUrl: string | null;
}

interface SchemaOrgPanelProps {
  eventId: string;
  onFieldsApplied?: (appliedFields: string[]) => void;
}

interface ComparisonField {
  key: string;
  label: string;
  eventValue: string | number | Date | null;
  schemaValue: string | number | Date | null;
  isDifferent: boolean;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (value instanceof Date) {
    return value.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  if (typeof value === "number") {
    return value.toString();
  }
  return String(value);
}

function formatDateForComparison(date: Date | string | null): string {
  if (!date) return "-";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function SchemaOrgPanel({ eventId, onFieldsApplied }: SchemaOrgPanelProps) {
  const [event, setEvent] = useState<EventData | null>(null);
  const [schemaOrg, setSchemaOrg] = useState<EventSchemaOrg | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/events/${eventId}/schema-org`);
      if (!res.ok) throw new Error("Failed to fetch data");
      const data = await res.json() as { event: EventData; schemaOrg: EventSchemaOrg | null };
      setEvent(data.event);
      setSchemaOrg(data.schemaOrg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/events/${eventId}/schema-org`, {
        method: "POST",
      });
      const data = await res.json() as { success: boolean; schemaOrg: EventSchemaOrg; error?: string };
      if (!data.success && data.error) {
        setError(data.error);
      }
      setSchemaOrg(data.schemaOrg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh data");
    } finally {
      setRefreshing(false);
    }
  };

  const handleApply = async () => {
    if (selectedFields.size === 0) return;

    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/events/${eventId}/schema-org`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: Array.from(selectedFields) }),
      });
      const data = await res.json() as { success: boolean; appliedFields: string[]; event: EventData; error?: string };
      if (!data.success) {
        throw new Error(data.error || "Failed to apply fields");
      }
      setEvent(data.event);
      setSelectedFields(new Set());
      onFieldsApplied?.(data.appliedFields);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply fields");
    } finally {
      setApplying(false);
    }
  };

  const toggleField = (field: string) => {
    const newSelected = new Set(selectedFields);
    if (newSelected.has(field)) {
      newSelected.delete(field);
    } else {
      newSelected.add(field);
    }
    setSelectedFields(newSelected);
  };

  const getComparisonFields = (): ComparisonField[] => {
    if (!event || !schemaOrg) return [];

    const fields: ComparisonField[] = [
      {
        key: "name",
        label: "Event Name",
        eventValue: event.name,
        schemaValue: schemaOrg.schemaName,
        isDifferent: !!schemaOrg.schemaName && event.name !== schemaOrg.schemaName,
      },
      {
        key: "description",
        label: "Description",
        eventValue: event.description,
        schemaValue: schemaOrg.schemaDescription,
        isDifferent: !!schemaOrg.schemaDescription && event.description !== schemaOrg.schemaDescription,
      },
      {
        key: "startDate",
        label: "Start Date",
        eventValue: event.startDate,
        schemaValue: schemaOrg.schemaStartDate,
        isDifferent: !!schemaOrg.schemaStartDate &&
          formatDateForComparison(event.startDate) !== formatDateForComparison(schemaOrg.schemaStartDate),
      },
      {
        key: "endDate",
        label: "End Date",
        eventValue: event.endDate,
        schemaValue: schemaOrg.schemaEndDate,
        isDifferent: !!schemaOrg.schemaEndDate &&
          formatDateForComparison(event.endDate) !== formatDateForComparison(schemaOrg.schemaEndDate),
      },
      {
        key: "ticketPriceMin",
        label: "Min Price",
        eventValue: event.ticketPriceMin,
        schemaValue: schemaOrg.schemaPriceMin,
        isDifferent: schemaOrg.schemaPriceMin !== null && event.ticketPriceMin !== schemaOrg.schemaPriceMin,
      },
      {
        key: "ticketPriceMax",
        label: "Max Price",
        eventValue: event.ticketPriceMax,
        schemaValue: schemaOrg.schemaPriceMax,
        isDifferent: schemaOrg.schemaPriceMax !== null && event.ticketPriceMax !== schemaOrg.schemaPriceMax,
      },
      {
        key: "imageUrl",
        label: "Image URL",
        eventValue: event.imageUrl,
        schemaValue: schemaOrg.schemaImageUrl,
        isDifferent: !!schemaOrg.schemaImageUrl && event.imageUrl !== schemaOrg.schemaImageUrl,
      },
      {
        key: "ticketUrl",
        label: "Ticket URL",
        eventValue: event.ticketUrl,
        schemaValue: schemaOrg.schemaTicketUrl,
        isDifferent: !!schemaOrg.schemaTicketUrl && event.ticketUrl !== schemaOrg.schemaTicketUrl,
      },
    ];

    return fields;
  };

  const getStatusBadge = () => {
    if (!schemaOrg) {
      return <Badge variant="secondary">Not Fetched</Badge>;
    }

    switch (schemaOrg.status) {
      case "available":
        return <Badge variant="success">Available</Badge>;
      case "not_found":
        return <Badge variant="secondary">Not Found</Badge>;
      case "invalid":
        return <Badge variant="warning">Invalid</Badge>;
      case "error":
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="secondary">Pending</Badge>;
    }
  };

  if (loading) {
    return (
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900">Schema.org Data</h2>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/4"></div>
            <div className="h-20 bg-gray-200 rounded"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const comparisonFields = getComparisonFields();
  const differingFields = comparisonFields.filter((f) => f.isDifferent);
  const hasTicketUrl = !!event?.ticketUrl;

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-lg font-semibold text-gray-900 hover:text-gray-700"
        >
          {expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          Schema.org Data
        </button>
        <div className="flex items-center gap-2">
          {getStatusBadge()}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || !hasTicketUrl}
            title={!hasTicketUrl ? "No ticket URL configured" : "Fetch schema.org data from ticket URL"}
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Fetching..." : "Refresh"}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent>
          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {!hasTicketUrl && (
            <div className="p-4 bg-gray-50 rounded-md text-gray-600 text-sm">
              <p>No ticket URL configured for this event. Add a ticket URL to fetch schema.org data.</p>
            </div>
          )}

          {hasTicketUrl && !schemaOrg && (
            <div className="p-4 bg-gray-50 rounded-md text-gray-600 text-sm">
              <p>Click &quot;Refresh&quot; to fetch schema.org data from the ticket URL.</p>
              {event?.ticketUrl && (
                <a
                  href={event.ticketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline mt-2"
                >
                  {event.ticketUrl}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {schemaOrg && schemaOrg.status === "available" && (
            <>
              <p className="text-sm text-gray-500 mb-4">
                Compare current event data with schema.org markup from the ticket URL.
                Select fields to update and click &quot;Apply Selected&quot;.
              </p>

              {differingFields.length > 0 && (
                <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-sm text-yellow-800">
                  {differingFields.length} field{differingFields.length !== 1 ? "s" : ""} differ
                  from schema.org data
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 pr-4 w-8"></th>
                      <th className="text-left py-2 pr-4 font-medium">Field</th>
                      <th className="text-left py-2 pr-4 font-medium">Current Value</th>
                      <th className="text-left py-2 font-medium">Schema.org Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonFields.map((field) => (
                      <tr
                        key={field.key}
                        className={`border-b ${field.isDifferent ? "bg-yellow-50" : ""}`}
                      >
                        <td className="py-2 pr-4">
                          {field.isDifferent && field.schemaValue !== null && (
                            <input
                              type="checkbox"
                              checked={selectedFields.has(field.key)}
                              onChange={() => toggleField(field.key)}
                              className="h-4 w-4 rounded border-gray-300"
                            />
                          )}
                        </td>
                        <td className="py-2 pr-4 font-medium text-gray-700">
                          {field.label}
                        </td>
                        <td className="py-2 pr-4 text-gray-600 max-w-xs truncate">
                          {field.key === "description"
                            ? (field.eventValue ? String(field.eventValue).substring(0, 100) + "..." : "-")
                            : formatValue(field.eventValue)}
                        </td>
                        <td className={`py-2 max-w-xs truncate ${field.isDifferent ? "text-yellow-700 font-medium" : "text-gray-600"}`}>
                          {field.key === "description"
                            ? (field.schemaValue ? String(field.schemaValue).substring(0, 100) + "..." : "-")
                            : formatValue(field.schemaValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedFields.size > 0 && (
                <div className="mt-4 flex items-center gap-4">
                  <Button
                    type="button"
                    onClick={handleApply}
                    disabled={applying}
                  >
                    <Check className="w-4 h-4 mr-1" />
                    {applying ? "Applying..." : `Apply ${selectedFields.size} Selected`}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setSelectedFields(new Set())}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Clear selection
                  </button>
                </div>
              )}

              {/* Additional venue/organizer info */}
              {(schemaOrg.schemaVenueName || schemaOrg.schemaOrganizerName) && (
                <div className="mt-6 pt-4 border-t">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Additional Schema.org Info</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    {schemaOrg.schemaVenueName && (
                      <div>
                        <span className="text-gray-500">Venue:</span>{" "}
                        <span className="text-gray-900">{schemaOrg.schemaVenueName}</span>
                        {schemaOrg.schemaVenueCity && (
                          <span className="text-gray-500"> - {schemaOrg.schemaVenueCity}, {schemaOrg.schemaVenueState}</span>
                        )}
                      </div>
                    )}
                    {schemaOrg.schemaOrganizerName && (
                      <div>
                        <span className="text-gray-500">Organizer:</span>{" "}
                        <span className="text-gray-900">{schemaOrg.schemaOrganizerName}</span>
                      </div>
                    )}
                    {schemaOrg.schemaEventStatus && (
                      <div>
                        <span className="text-gray-500">Status:</span>{" "}
                        <span className="text-gray-900">{schemaOrg.schemaEventStatus}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Last fetched info */}
              <div className="mt-4 pt-4 border-t text-xs text-gray-400">
                Last fetched: {schemaOrg.lastFetchedAt
                  ? new Date(schemaOrg.lastFetchedAt).toLocaleString()
                  : "Never"}
                {schemaOrg.fetchCount && ` (${schemaOrg.fetchCount} total fetches)`}
                {schemaOrg.ticketUrl && (
                  <>
                    {" "}from{" "}
                    <a
                      href={schemaOrg.ticketUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:underline"
                    >
                      {new URL(schemaOrg.ticketUrl).hostname}
                    </a>
                  </>
                )}
              </div>
            </>
          )}

          {schemaOrg && schemaOrg.status === "not_found" && (
            <div className="p-4 bg-gray-50 rounded-md text-gray-600 text-sm">
              <p>No schema.org Event markup was found on the ticket URL.</p>
              <p className="mt-2 text-gray-500">
                The page may not include structured data, or it may use a different format.
              </p>
              {schemaOrg.ticketUrl && (
                <a
                  href={schemaOrg.ticketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline mt-2"
                >
                  View page
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {schemaOrg && schemaOrg.status === "error" && (
            <div className="p-4 bg-red-50 rounded-md text-red-600 text-sm">
              <p className="font-medium">Error fetching schema.org data</p>
              {schemaOrg.lastError && <p className="mt-1">{schemaOrg.lastError}</p>}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
