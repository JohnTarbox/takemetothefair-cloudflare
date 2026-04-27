"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Link2,
  Loader2,
  Check,
  AlertCircle,
  ExternalLink,
  Calendar,
  MapPin,
  DollarSign,
  Sparkles,
  AlertTriangle,
  Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DailyScheduleInput, type EventDayInput } from "@/components/events/DailyScheduleInput";
import { trackEvent } from "@/lib/analytics";
import { EVENT_CATEGORIES } from "@/lib/constants";
import type { ExtractedEventData, FieldConfidence } from "@/lib/url-import/types";

type WizardStep =
  | "url-input"
  | "fetching"
  | "extracting"
  | "duplicate-check"
  | "venue-match"
  | "review"
  | "submitting"
  | "success";

// API response types
interface FetchResponse {
  success: boolean;
  content?: string;
  title?: string;
  description?: string;
  ogImage?: string;
  jsonLd?: Record<string, unknown>;
  error?: string;
  retryAfter?: number;
}

interface ExtractResponse {
  success: boolean;
  extracted?: ExtractedEventData;
  confidence?: FieldConfidence;
  error?: string;
}

interface DuplicateCheckResponse {
  success: boolean;
  isDuplicate?: boolean;
  matchType?: "exact_url" | "similar_name_date";
  similarity?: number;
  existingEvent?: {
    id: string;
    name: string;
    slug: string;
    startDate: string | null;
    endDate: string | null;
  };
}

interface VenueMatch {
  id: string;
  name: string;
  city: string;
  state: string;
  similarity: number;
}

interface VenueMatchResponse {
  success: boolean;
  matchFound: boolean;
  bestMatch?: VenueMatch;
  alternatives?: VenueMatch[];
}

interface SubmitResponse {
  success: boolean;
  event?: { id: string; slug: string; name: string };
  error?: string;
  retryAfter?: number;
}

export default function VendorSuggestEventPage() {
  // Wizard state
  const [step, setStep] = useState<WizardStep>("url-input");
  const [url, setUrl] = useState("");
  const [manualPaste, setManualPaste] = useState(false);
  const [pastedContent, setPastedContent] = useState("");
  const [_fetchedContent, setFetchedContent] = useState("");
  const [fetchedJsonLd, setFetchedJsonLd] = useState<Record<string, unknown> | null>(null);
  const [extractedData, setExtractedData] = useState<ExtractedEventData>({
    name: null,
    description: null,
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    hoursVaryByDay: false,
    hoursNotes: null,
    specificDates: null,
    venueName: null,
    venueAddress: null,
    venueCity: null,
    venueState: null,
    isStatewide: false,
    stateCode: null,
    ticketUrl: null,
    ticketPriceMin: null,
    ticketPriceMax: null,
    imageUrl: null,
    categories: null,
    vendorFeeMin: null,
    vendorFeeMax: null,
    vendorFeeNotes: null,
    indoorOutdoor: null,
    estimatedAttendance: null,
    applicationUrl: null,
    walkInsAllowed: null,
  });
  const [confidence, setConfidence] = useState<FieldConfidence>({});
  const [eventDays, setEventDays] = useState<EventDayInput[]>([]);
  const [error, setError] = useState("");
  const [createdEvent, setCreatedEvent] = useState<{
    id: string;
    slug: string;
    name: string;
  } | null>(null);
  const [duplicateEvent, setDuplicateEvent] = useState<
    DuplicateCheckResponse["existingEvent"] | null
  >(null);
  const [duplicateMatchType, setDuplicateMatchType] = useState<string | null>(null);
  const [matchedVenue, setMatchedVenue] = useState<VenueMatch | null>(null);
  const [alternativeVenues, setAlternativeVenues] = useState<VenueMatch[]>([]);
  const [confirmedVenueId, setConfirmedVenueId] = useState<string | null>(null);

  // Step: Fetch URL content
  const handleFetchUrl = async () => {
    if (!url.trim()) {
      // Skip URL step, go directly to review with empty form
      setStep("review");
      return;
    }

    setError("");
    setStep("fetching");

    try {
      const res = await fetch(`/api/suggest-event/fetch?url=${encodeURIComponent(url)}`);
      const data = (await res.json()) as FetchResponse;

      if (!data.success) {
        if (res.status === 429) {
          const minutes = Math.ceil((data.retryAfter || 3600) / 60);
          setError(
            `Too many requests. Please try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`
          );
          setStep("url-input");
          return;
        }
        setError(
          data.error ||
            "Failed to fetch URL. You can paste the content manually or fill in the details."
        );
        setManualPaste(true);
        setStep("url-input");
        return;
      }

      setFetchedContent(data.content || "");
      if (data.jsonLd) setFetchedJsonLd(data.jsonLd);

      // Pre-fill from metadata
      if (data.ogImage) {
        setExtractedData((prev) => ({ ...prev, imageUrl: data.ogImage || null }));
      }

      // Auto-extract
      setStep("extracting");
      await handleExtract(data.content || "", {
        title: data.title,
        description: data.description,
        ogImage: data.ogImage,
        jsonLd: data.jsonLd,
      });
    } catch {
      setError("Failed to fetch URL. You can paste the content manually or fill in the details.");
      setManualPaste(true);
      setStep("url-input");
    }
  };

  // Step: Extract event data from content
  const handleExtract = async (
    content: string,
    metadata?: {
      title?: string;
      description?: string;
      ogImage?: string;
      jsonLd?: Record<string, unknown>;
    }
  ) => {
    try {
      const res = await fetch("/api/suggest-event/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          url,
          metadata: metadata || {},
        }),
      });
      const data = (await res.json()) as ExtractResponse;

      if (data.extracted) {
        setExtractedData(data.extracted);
        setConfidence(data.confidence || {});
      }

      // Check for duplicates
      setStep("duplicate-check");
      await handleDuplicateCheck(data.extracted || extractedData);
    } catch {
      setError("Failed to extract event data. Please fill in manually.");
      setStep("review");
    }
  };

  // Step: Check for duplicates
  const handleDuplicateCheck = async (eventData: ExtractedEventData) => {
    try {
      const res = await fetch("/api/suggest-event/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUrl: url || undefined,
          name: eventData.name || undefined,
          startDate: eventData.startDate || undefined,
        }),
      });
      const data = (await res.json()) as DuplicateCheckResponse;

      if (data.isDuplicate && data.existingEvent) {
        setDuplicateEvent(data.existingEvent);
        setDuplicateMatchType(data.matchType || null);
      } else {
        setDuplicateEvent(null);
        setDuplicateMatchType(null);
        await handleVenueMatch(eventData);
      }
    } catch {
      setStep("review");
    }
  };

  // Step: Check for venue matches
  const handleVenueMatch = async (eventData: ExtractedEventData) => {
    if (!eventData.venueName) {
      setStep("review");
      return;
    }

    setStep("venue-match");

    try {
      const res = await fetch("/api/suggest-event/match-venue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueName: eventData.venueName,
          venueCity: eventData.venueCity || undefined,
          venueState: eventData.venueState || undefined,
        }),
      });
      const data = (await res.json()) as VenueMatchResponse;

      if (data.matchFound && data.bestMatch) {
        setMatchedVenue(data.bestMatch);
        setAlternativeVenues(data.alternatives || []);
      } else {
        setMatchedVenue(null);
        setAlternativeVenues([]);
        setStep("review");
      }
    } catch {
      setStep("review");
    }
  };

  const confirmVenue = (venueId: string) => {
    setConfirmedVenueId(venueId);
    setStep("review");
  };

  const skipVenueMatch = () => {
    setConfirmedVenueId(null);
    setMatchedVenue(null);
    setStep("review");
  };

  const proceedAnyway = async () => {
    setDuplicateEvent(null);
    await handleVenueMatch(extractedData);
  };

  // Step: Submit event
  const handleSubmit = async () => {
    if (!extractedData.name?.trim()) {
      setError("Event name is required");
      return;
    }

    setError("");
    setStep("submitting");

    try {
      const res = await fetch("/api/suggest-event/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...extractedData,
          venueId: confirmedVenueId || undefined,
          sourceUrl: url || undefined,
          jsonLd: fetchedJsonLd || undefined,
          eventDays: eventDays.length > 0 ? eventDays : undefined,
          source: "vendor", // Vendor submission → TENTATIVE status
        }),
      });

      const data = (await res.json()) as SubmitResponse;

      if (!data.success) {
        if (res.status === 429) {
          const retryAfter = data.retryAfter || 3600;
          const minutes = Math.ceil(retryAfter / 60);
          setError(
            `Too many requests. Please try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`
          );
        } else {
          setError(data.error || "Failed to submit event");
        }
        setStep("review");
        return;
      }

      setCreatedEvent(data.event || null);
      setStep("success");
      trackEvent("event_suggest", {
        category: "conversion",
        label: extractedData.name || undefined,
      });
    } catch {
      setError("Failed to submit event. Please try again.");
      setStep("review");
    }
  };

  // Reset wizard
  const resetWizard = () => {
    setStep("url-input");
    setUrl("");
    setManualPaste(false);
    setPastedContent("");
    setFetchedContent("");
    setFetchedJsonLd(null);
    setExtractedData({
      name: null,
      description: null,
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      hoursVaryByDay: false,
      hoursNotes: null,
      specificDates: null,
      venueName: null,
      venueAddress: null,
      venueCity: null,
      venueState: null,
      isStatewide: false,
      stateCode: null,
      ticketUrl: null,
      ticketPriceMin: null,
      ticketPriceMax: null,
      imageUrl: null,
      categories: null,
      vendorFeeMin: null,
      vendorFeeMax: null,
      vendorFeeNotes: null,
      indoorOutdoor: null,
      estimatedAttendance: null,
      applicationUrl: null,
      walkInsAllowed: null,
    });
    setConfidence({});
    setEventDays([]);
    setDuplicateEvent(null);
    setDuplicateMatchType(null);
    setMatchedVenue(null);
    setAlternativeVenues([]);
    setConfirmedVenueId(null);
    setCreatedEvent(null);
    setError("");
  };

  // Confidence badge component
  const ConfidenceBadge = ({ field }: { field: string }) => {
    const level = confidence[field];
    if (!level) return null;

    const colors = {
      high: "bg-green-500",
      medium: "bg-yellow-500",
      low: "bg-red-500",
    };

    return (
      <span
        className={`inline-block w-2 h-2 rounded-full ${colors[level]} ml-1`}
        title={`${level} confidence`}
      />
    );
  };

  const formatDateForDisplay = (dateStr: string | null) => {
    if (!dateStr) return "TBD";
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/vendor/applications"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Applications
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Suggest an Event</h1>
        <p className="text-gray-600 mt-1">
          Know about an upcoming fair, festival, or market? Submit it here and it will appear on the
          site with a &ldquo;Tentative&rdquo; badge until verified by our team.
        </p>
        <p className="text-sm text-amber-700 bg-amber-50 rounded-lg p-3 mt-3">
          It&apos;s OK if details are incomplete — admins will verify and fill in missing
          information.
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Step: URL Input */}
      {step === "url-input" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="w-5 h-5" />
              Enter Event URL
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Paste a link to the event page and we&apos;ll automatically extract the details. Or
              skip this step to fill in the details manually.
            </p>

            {!manualPaste ? (
              <>
                <div>
                  <Label htmlFor="url">Event Page URL</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      id="url"
                      type="url"
                      placeholder="https://example.com/event-page"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleFetchUrl();
                        }
                      }}
                    />
                    <Button onClick={handleFetchUrl} disabled={!url.trim()}>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Extract
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setManualPaste(true)}
                    className="text-sm text-blue-600 hover:text-blue-700"
                  >
                    Paste content manually instead
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    type="button"
                    onClick={() => setStep("review")}
                    className="text-sm text-blue-600 hover:text-blue-700"
                  >
                    Skip — fill in manually
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label htmlFor="paste">Paste the event page content below</Label>
                  <textarea
                    id="paste"
                    rows={8}
                    className="w-full mt-1 p-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Copy and paste the text content from the event page here..."
                    value={pastedContent}
                    onChange={(e) => setPastedContent(e.target.value)}
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setStep("extracting");
                      handleExtract(pastedContent);
                    }}
                    disabled={!pastedContent.trim()}
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    Extract from Text
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setManualPaste(false);
                      setPastedContent("");
                    }}
                  >
                    Back
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step: Fetching */}
      {step === "fetching" && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-gray-600">Fetching event page...</p>
          </CardContent>
        </Card>
      )}

      {/* Step: Extracting */}
      {step === "extracting" && (
        <Card>
          <CardContent className="py-12 text-center">
            <Sparkles className="w-8 h-8 text-purple-600 mx-auto mb-4 animate-pulse" />
            <p className="text-gray-600">Extracting event details with AI...</p>
          </CardContent>
        </Card>
      )}

      {/* Step: Duplicate Check Warning */}
      {step === "duplicate-check" && duplicateEvent && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              Possible Duplicate Found
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              {duplicateMatchType === "exact_url"
                ? "An event with this URL already exists:"
                : "A similar event may already exist:"}
            </p>

            <div className="bg-gray-50 rounded-lg p-4">
              <p className="font-medium text-gray-900">{duplicateEvent.name}</p>
              {duplicateEvent.startDate && (
                <p className="text-sm text-gray-600 mt-1">
                  {formatDateForDisplay(duplicateEvent.startDate)}
                  {duplicateEvent.endDate && ` — ${formatDateForDisplay(duplicateEvent.endDate)}`}
                </p>
              )}
              <Link
                href={`/events/${duplicateEvent.slug}`}
                className="text-sm text-blue-600 hover:text-blue-700 inline-flex items-center gap-1 mt-2"
              >
                View existing event <ExternalLink className="w-3 h-3" />
              </Link>
            </div>

            <div className="flex gap-2">
              <Button onClick={proceedAnyway}>Submit Anyway</Button>
              <Button variant="outline" onClick={resetWizard}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Venue Match */}
      {step === "venue-match" && matchedVenue && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5" />
              Venue Match Found
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              We found a venue that matches. Would you like to link this event to it?
            </p>

            <div
              className="bg-blue-50 rounded-lg p-4 cursor-pointer border-2 border-blue-200 hover:border-blue-400"
              onClick={() => confirmVenue(matchedVenue.id)}
            >
              <p className="font-medium text-gray-900">{matchedVenue.name}</p>
              <p className="text-sm text-gray-600">
                {matchedVenue.city}, {matchedVenue.state}
              </p>
            </div>

            {alternativeVenues.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">Other possible matches:</p>
                {alternativeVenues.map((v) => (
                  <div
                    key={v.id}
                    className="bg-gray-50 rounded-lg p-3 cursor-pointer hover:bg-gray-100"
                    onClick={() => confirmVenue(v.id)}
                  >
                    <p className="text-sm font-medium text-gray-900">{v.name}</p>
                    <p className="text-xs text-gray-600">
                      {v.city}, {v.state}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={skipVenueMatch}
              className="text-sm text-gray-600 hover:text-gray-800"
            >
              Skip — don&apos;t link to a venue
            </button>
          </CardContent>
        </Card>
      )}

      {/* Step: Review & Edit */}
      {step === "review" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Review Event Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="name">
                Event Name *
                <ConfidenceBadge field="name" />
              </Label>
              <Input
                id="name"
                value={extractedData.name || ""}
                onChange={(e) => setExtractedData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Maine State Fair"
              />
            </div>

            <div>
              <Label htmlFor="description">
                Description
                <ConfidenceBadge field="description" />
              </Label>
              <textarea
                id="description"
                rows={4}
                className="w-full p-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={extractedData.description || ""}
                onChange={(e) =>
                  setExtractedData((prev) => ({ ...prev, description: e.target.value }))
                }
                placeholder="Brief description of the event"
              />
            </div>

            <div>
              <Label>
                Categories
                <ConfidenceBadge field="categories" />
              </Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {EVENT_CATEGORIES.map((cat) => {
                  const selected = extractedData.categories?.includes(cat) ?? false;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() =>
                        setExtractedData((prev) => {
                          const current = prev.categories || [];
                          const next = selected
                            ? current.filter((c) => c !== cat)
                            : [...current, cat];
                          return { ...prev, categories: next.length > 0 ? next : null };
                        })
                      }
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        selected
                          ? "bg-blue-100 text-blue-700 ring-1 ring-blue-300"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="startDate">
                  Start Date
                  <ConfidenceBadge field="startDate" />
                </Label>
                <Input
                  id="startDate"
                  type="date"
                  value={extractedData.startDate || ""}
                  onChange={(e) =>
                    setExtractedData((prev) => ({ ...prev, startDate: e.target.value || null }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="endDate">
                  End Date
                  <ConfidenceBadge field="endDate" />
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={extractedData.endDate || ""}
                  onChange={(e) =>
                    setExtractedData((prev) => ({ ...prev, endDate: e.target.value || null }))
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="startTime">
                  Opening Time
                  <ConfidenceBadge field="startTime" />
                </Label>
                <Input
                  id="startTime"
                  type="time"
                  value={extractedData.startTime || ""}
                  onChange={(e) =>
                    setExtractedData((prev) => ({ ...prev, startTime: e.target.value || null }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="endTime">
                  Closing Time
                  <ConfidenceBadge field="endTime" />
                </Label>
                <Input
                  id="endTime"
                  type="time"
                  value={extractedData.endTime || ""}
                  onChange={(e) =>
                    setExtractedData((prev) => ({ ...prev, endTime: e.target.value || null }))
                  }
                />
              </div>
            </div>

            <DailyScheduleInput
              startDate={extractedData.startDate || ""}
              endDate={extractedData.endDate || ""}
              initialDays={eventDays}
              discontinuousDates={false}
              onChange={setEventDays}
            />

            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 flex items-center gap-1 mb-3">
                <MapPin className="w-4 h-4" />
                Venue Information
              </h3>
              {confirmedVenueId ? (
                <div className="bg-green-50 rounded-lg p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-600" />
                    <span className="text-sm text-green-700">
                      Linked to: {matchedVenue?.name || "Selected venue"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmedVenueId(null);
                      setMatchedVenue(null);
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Label htmlFor="venueName">
                      Venue Name
                      <ConfidenceBadge field="venueName" />
                    </Label>
                    <Input
                      id="venueName"
                      value={extractedData.venueName || ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({ ...prev, venueName: e.target.value }))
                      }
                      placeholder="e.g. Fryeburg Fairgrounds"
                    />
                  </div>
                  <div className="col-span-2">
                    <Label htmlFor="venueAddress">Venue Address</Label>
                    <Input
                      id="venueAddress"
                      value={extractedData.venueAddress || ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({ ...prev, venueAddress: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="venueCity">City</Label>
                    <Input
                      id="venueCity"
                      value={extractedData.venueCity || ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({ ...prev, venueCity: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="venueState">State</Label>
                    <Input
                      id="venueState"
                      value={extractedData.venueState || ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({ ...prev, venueState: e.target.value }))
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 flex items-center gap-1 mb-3">
                <DollarSign className="w-4 h-4" />
                Ticket Information
              </h3>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="ticketUrl">Event/Ticket URL</Label>
                  <Input
                    id="ticketUrl"
                    type="url"
                    value={extractedData.ticketUrl || ""}
                    onChange={(e) =>
                      setExtractedData((prev) => ({ ...prev, ticketUrl: e.target.value }))
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="ticketPriceMin">Min Price ($)</Label>
                    <Input
                      id="ticketPriceMin"
                      type="number"
                      step="0.01"
                      min="0"
                      value={extractedData.ticketPriceMin ?? ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({
                          ...prev,
                          ticketPriceMin: e.target.value ? parseFloat(e.target.value) : null,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="ticketPriceMax">Max Price ($)</Label>
                    <Input
                      id="ticketPriceMax"
                      type="number"
                      step="0.01"
                      min="0"
                      value={extractedData.ticketPriceMax ?? ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({
                          ...prev,
                          ticketPriceMax: e.target.value ? parseFloat(e.target.value) : null,
                        }))
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 flex items-center gap-1 mb-3">
                <Store className="w-4 h-4" />
                Vendor Information
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                If you know details about vendor/booth fees or application process, fill them in
                here.
              </p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="vendorFeeMin">
                      Vendor Fee Min ($)
                      <ConfidenceBadge field="vendorFeeMin" />
                    </Label>
                    <Input
                      id="vendorFeeMin"
                      type="number"
                      step="0.01"
                      min="0"
                      value={extractedData.vendorFeeMin ?? ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({
                          ...prev,
                          vendorFeeMin: e.target.value ? parseFloat(e.target.value) : null,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="vendorFeeMax">
                      Vendor Fee Max ($)
                      <ConfidenceBadge field="vendorFeeMax" />
                    </Label>
                    <Input
                      id="vendorFeeMax"
                      type="number"
                      step="0.01"
                      min="0"
                      value={extractedData.vendorFeeMax ?? ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({
                          ...prev,
                          vendorFeeMax: e.target.value ? parseFloat(e.target.value) : null,
                        }))
                      }
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="vendorFeeNotes">Fee Details/Notes</Label>
                  <Input
                    id="vendorFeeNotes"
                    value={extractedData.vendorFeeNotes || ""}
                    onChange={(e) =>
                      setExtractedData((prev) => ({ ...prev, vendorFeeNotes: e.target.value }))
                    }
                    placeholder="e.g. $50 for 10x10, $75 with electricity"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="indoorOutdoor">
                      Indoor/Outdoor
                      <ConfidenceBadge field="indoorOutdoor" />
                    </Label>
                    <select
                      id="indoorOutdoor"
                      value={extractedData.indoorOutdoor || ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({
                          ...prev,
                          indoorOutdoor: (e.target.value as "INDOOR" | "OUTDOOR" | "MIXED") || null,
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">Unknown</option>
                      <option value="INDOOR">Indoor</option>
                      <option value="OUTDOOR">Outdoor</option>
                      <option value="MIXED">Mixed (Indoor & Outdoor)</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="estimatedAttendance">
                      Est. Attendance
                      <ConfidenceBadge field="estimatedAttendance" />
                    </Label>
                    <Input
                      id="estimatedAttendance"
                      type="number"
                      min="0"
                      value={extractedData.estimatedAttendance ?? ""}
                      onChange={(e) =>
                        setExtractedData((prev) => ({
                          ...prev,
                          estimatedAttendance: e.target.value ? parseInt(e.target.value) : null,
                        }))
                      }
                      placeholder="e.g. 5000"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="applicationUrl">
                    Vendor Application URL
                    <ConfidenceBadge field="applicationUrl" />
                  </Label>
                  <Input
                    id="applicationUrl"
                    type="url"
                    value={extractedData.applicationUrl || ""}
                    onChange={(e) =>
                      setExtractedData((prev) => ({ ...prev, applicationUrl: e.target.value }))
                    }
                    placeholder="Link to vendor application form"
                  />
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={extractedData.walkInsAllowed || false}
                    onChange={(e) =>
                      setExtractedData((prev) => ({ ...prev, walkInsAllowed: e.target.checked }))
                    }
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Walk-in vendors welcome</span>
                </label>
              </div>
            </div>

            <div>
              <Label htmlFor="imageUrl">Image URL</Label>
              <Input
                id="imageUrl"
                type="url"
                value={extractedData.imageUrl || ""}
                onChange={(e) =>
                  setExtractedData((prev) => ({ ...prev, imageUrl: e.target.value }))
                }
              />
            </div>

            <div className="flex gap-2 pt-4">
              <Button onClick={handleSubmit}>
                <Check className="w-4 h-4 mr-2" />
                Submit Event
              </Button>
              <Button variant="outline" onClick={resetWizard}>
                Start Over
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Submitting */}
      {step === "submitting" && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-gray-600">Submitting event...</p>
          </CardContent>
        </Card>
      )}

      {/* Step: Success */}
      {step === "success" && (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Event Submitted!</h2>
            <p className="text-gray-600 mb-1">
              Your event has been published with a <strong>&ldquo;Tentative&rdquo;</strong> badge.
            </p>
            <p className="text-sm text-gray-500 mb-6">
              Our team will verify the details and remove the tentative status once confirmed.
            </p>

            {createdEvent && (
              <div className="mb-6">
                <Link
                  href={`/events/${createdEvent.slug}`}
                  className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium"
                >
                  View &ldquo;{createdEvent.name}&rdquo; <ExternalLink className="w-4 h-4" />
                </Link>
              </div>
            )}

            <div className="flex gap-3 justify-center">
              <Button onClick={resetWizard}>
                <Calendar className="w-4 h-4 mr-2" />
                Submit Another
              </Button>
              <Link href="/vendor/submissions">
                <Button variant="outline">View My Submissions</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
