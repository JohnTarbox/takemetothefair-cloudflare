"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import Script from "next/script";
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
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Mail,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  ExtractedEventData,
  FieldConfidence,
} from "@/lib/url-import/types";

export const runtime = "edge";

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
    slug: string;
    name: string;
    startDate: Date | null;
    status: string;
  };
  error?: string;
}

interface SubmitResponse {
  success: boolean;
  event?: { id: string; slug: string; name: string };
  error?: string;
  retryAfter?: number;
}

// Turnstile widget types
declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId: string) => string | undefined;
    };
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (error: string) => void;
  size?: "normal" | "compact" | "invisible";
  theme?: "light" | "dark" | "auto";
}

interface MatchedVenue {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  address?: string | null;
  confidence: number;
}

interface VenueMatchResponse {
  success: boolean;
  matchFound?: boolean;
  bestMatch?: MatchedVenue;
  alternatives?: MatchedVenue[];
  error?: string;
}

export default function SuggestEventPage() {
  // Wizard state
  const [step, setStep] = useState<WizardStep>("url-input");
  const [error, setError] = useState("");

  // URL input state
  const [url, setUrl] = useState("");
  const [manualPaste, setManualPaste] = useState(false);
  const [pastedContent, setPastedContent] = useState("");

  // Fetched content state
  const [fetchedContent, setFetchedContent] = useState("");
  const [fetchedJsonLd, setFetchedJsonLd] = useState<Record<string, unknown> | null>(null);

  // Extracted data state
  const [extractedData, setExtractedData] = useState<ExtractedEventData>({
    name: null,
    description: null,
    startDate: null,
    endDate: null,
    venueName: null,
    venueAddress: null,
    venueCity: null,
    venueState: null,
    ticketUrl: null,
    ticketPriceMin: null,
    ticketPriceMax: null,
    imageUrl: null,
  });
  const [confidence, setConfidence] = useState<FieldConfidence>({});

  // Duplicate check state
  const [duplicateEvent, setDuplicateEvent] = useState<DuplicateCheckResponse["existingEvent"] | null>(null);
  const [duplicateMatchType, setDuplicateMatchType] = useState<string | null>(null);

  // Venue match state
  const [matchedVenue, setMatchedVenue] = useState<MatchedVenue | null>(null);
  const [alternativeVenues, setAlternativeVenues] = useState<MatchedVenue[]>([]);
  const [confirmedVenueId, setConfirmedVenueId] = useState<string | null>(null);

  // User input state
  const [suggesterEmail, setSuggesterEmail] = useState("");

  // Success state
  const [createdEvent, setCreatedEvent] = useState<{ id: string; slug: string; name: string } | null>(null);

  // Turnstile state
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState(false);
  const turnstileWidgetId = useRef<string | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);

  // Get the Turnstile site key from environment
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // Initialize Turnstile widget
  const initTurnstile = useCallback(() => {
    if (!turnstileSiteKey || !window.turnstile || !turnstileContainerRef.current) {
      return;
    }

    // Remove existing widget if any
    if (turnstileWidgetId.current) {
      try {
        window.turnstile.remove(turnstileWidgetId.current);
      } catch {
        // Widget might already be removed
      }
    }

    // Render invisible Turnstile widget
    turnstileWidgetId.current = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: turnstileSiteKey,
      size: "invisible",
      callback: (token: string) => {
        setTurnstileToken(token);
      },
      "expired-callback": () => {
        setTurnstileToken("");
      },
      "error-callback": () => {
        setTurnstileToken("");
      },
    });

    setTurnstileReady(true);
  }, [turnstileSiteKey]);

  // Reset Turnstile after submission
  const resetTurnstile = useCallback(() => {
    if (window.turnstile && turnstileWidgetId.current) {
      try {
        window.turnstile.reset(turnstileWidgetId.current);
      } catch {
        // Widget might not exist
      }
    }
    setTurnstileToken("");
  }, []);

  // URL validation
  const isValidUrl = (urlString: string): boolean => {
    try {
      const parsed = new URL(urlString);
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  };

  // Step: Fetch URL
  const handleFetch = async () => {
    if (!manualPaste && !isValidUrl(url)) {
      setError("Please enter a valid URL");
      return;
    }

    setError("");

    if (manualPaste) {
      if (!pastedContent.trim()) {
        setError("Please paste some content");
        return;
      }
      setFetchedContent(pastedContent);
      setStep("extracting");
      await handleExtract(pastedContent);
      return;
    }

    setStep("fetching");

    try {
      const res = await fetch(
        `/api/suggest-event/fetch?url=${encodeURIComponent(url)}`
      );
      const data = (await res.json()) as FetchResponse;

      if (!data.success) {
        // Handle rate limiting
        if (res.status === 429) {
          const retryAfter = data.retryAfter || 3600;
          const minutes = Math.ceil(retryAfter / 60);
          setError(`Too many requests. Please try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`);
        } else {
          setError(data.error || "Failed to fetch page");
        }
        setStep("url-input");
        return;
      }

      setFetchedContent(data.content || "");
      setFetchedJsonLd(data.jsonLd || null);

      setStep("extracting");
      await handleExtract(data.content || "", {
        title: data.title,
        description: data.description,
        ogImage: data.ogImage,
        jsonLd: data.jsonLd,
      });
    } catch {
      setError("Failed to fetch page. Try pasting the content manually.");
      setStep("url-input");
    }
  };

  // Step: AI Extract
  const handleExtract = async (
    content: string,
    metadata?: { title?: string; description?: string; ogImage?: string; jsonLd?: Record<string, unknown> }
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
        // Stay on duplicate-check step to show warning
      } else {
        // No duplicate, check for venue matches
        setDuplicateEvent(null);
        setDuplicateMatchType(null);
        await handleVenueMatch(eventData);
      }
    } catch {
      // Error checking duplicates - proceed to review
      setStep("review");
    }
  };

  // Step: Check for venue matches
  const handleVenueMatch = async (eventData: ExtractedEventData) => {
    // Only check if we have a venue name
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
        // Stay on venue-match step to show confirmation
      } else {
        // No venue match found, proceed to review
        setMatchedVenue(null);
        setAlternativeVenues([]);
        setStep("review");
      }
    } catch {
      // Error matching venue - proceed to review without venue link
      setStep("review");
    }
  };

  // Confirm the matched venue
  const confirmVenue = (venueId: string) => {
    setConfirmedVenueId(venueId);
    setStep("review");
  };

  // Skip venue linking
  const skipVenueMatch = () => {
    setConfirmedVenueId(null);
    setMatchedVenue(null);
    setStep("review");
  };

  // Proceed despite duplicate warning
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
          suggesterEmail: suggesterEmail || undefined,
          jsonLd: fetchedJsonLd || undefined,
          turnstileToken: turnstileToken || undefined,
        }),
      });

      const data = (await res.json()) as SubmitResponse;

      if (!data.success) {
        // Handle rate limiting
        if (res.status === 429) {
          const retryAfter = data.retryAfter || 3600;
          const minutes = Math.ceil(retryAfter / 60);
          setError(`Too many requests. Please try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`);
        } else {
          setError(data.error || "Failed to submit event");
        }
        resetTurnstile();
        setStep("review");
        return;
      }

      setCreatedEvent(data.event || null);
      setStep("success");
    } catch {
      setError("Failed to submit event. Please try again.");
      resetTurnstile();
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
      venueName: null,
      venueAddress: null,
      venueCity: null,
      venueState: null,
      ticketUrl: null,
      ticketPriceMin: null,
      ticketPriceMax: null,
      imageUrl: null,
    });
    setConfidence({});
    setDuplicateEvent(null);
    setDuplicateMatchType(null);
    setMatchedVenue(null);
    setAlternativeVenues([]);
    setConfirmedVenueId(null);
    setSuggesterEmail("");
    setCreatedEvent(null);
    setError("");
    resetTurnstile();
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

  // Format date for display
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
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Turnstile Script */}
      {turnstileSiteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onLoad={initTurnstile}
        />
      )}

      {/* Invisible Turnstile widget container */}
      <div ref={turnstileContainerRef} className="hidden" />

      {/* Header */}
      <div className="mb-6">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Home
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Suggest an Event</h1>
        <p className="text-gray-600 mt-1">
          Know about an upcoming fair, festival, or market? Help the community by suggesting it!
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
              Paste a link to the event page and we&apos;ll automatically extract the details.
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
                      className="flex-1"
                    />
                    <Button onClick={handleFetch} disabled={!url}>
                      Fetch Page
                    </Button>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={manualPaste}
                    onChange={(e) => setManualPaste(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  I can&apos;t fetch the page - let me paste content
                </label>
              </>
            ) : (
              <>
                <div>
                  <Label htmlFor="pastedContent">Paste Page Content</Label>
                  <textarea
                    id="pastedContent"
                    className="mt-1 w-full h-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    placeholder="Paste the event page content here..."
                    value={pastedContent}
                    onChange={(e) => setPastedContent(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="urlManual">Source URL (optional)</Label>
                  <Input
                    id="urlManual"
                    type="url"
                    placeholder="https://example.com/event-page"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleFetch} disabled={!pastedContent.trim()}>
                    Extract Event Data
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setManualPaste(false);
                      setPastedContent("");
                    }}
                  >
                    Back to URL
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
            <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
            <h3 className="text-lg font-medium text-gray-900">
              Fetching page content...
            </h3>
            <p className="text-gray-500 mt-2">This may take a few seconds</p>
          </CardContent>
        </Card>
      )}

      {/* Step: Extracting */}
      {step === "extracting" && (
        <Card>
          <CardContent className="py-12 text-center">
            <Sparkles className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-pulse" />
            <h3 className="text-lg font-medium text-gray-900">
              Analyzing page content...
            </h3>
            <p className="text-gray-500 mt-2">
              AI is extracting event details
            </p>
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
            <p className="text-gray-700">
              {duplicateMatchType === "exact_url"
                ? "An event from this URL already exists in our database."
                : "A similar event already exists in our database."}
            </p>

            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <h4 className="font-medium text-gray-900">{duplicateEvent.name}</h4>
              {duplicateEvent.startDate && (
                <p className="text-sm text-gray-600 mt-1">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  {formatDateForDisplay(duplicateEvent.startDate.toString())}
                </p>
              )}
              <p className="text-sm text-gray-500 mt-1">
                Status: {duplicateEvent.status}
              </p>
              <Link
                href={`/events/${duplicateEvent.slug}`}
                className="text-sm text-blue-600 hover:underline mt-2 inline-flex items-center"
                target="_blank"
              >
                View existing event
                <ExternalLink className="w-3 h-3 ml-1" />
              </Link>
            </div>

            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep("url-input")}>
                <ChevronLeft className="w-4 h-4 mr-1" />
                Try Different URL
              </Button>
              <Button onClick={proceedAnyway} variant="outline">
                Submit Anyway
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Duplicate check loading (no duplicate found) */}
      {step === "duplicate-check" && !duplicateEvent && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
            <h3 className="text-lg font-medium text-gray-900">
              Checking for duplicates...
            </h3>
          </CardContent>
        </Card>
      )}

      {/* Step: Venue Match Confirmation */}
      {step === "venue-match" && matchedVenue && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-blue-600">
              <MapPin className="w-5 h-5" />
              Venue Found in Database
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-gray-700">
              We found a venue that matches &quot;{extractedData.venueName}&quot;. Would you like to link this event to it?
            </p>

            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h4 className="font-medium text-gray-900">{matchedVenue.name}</h4>
              <p className="text-sm text-gray-600 mt-1">
                <MapPin className="w-3 h-3 inline mr-1" />
                {[matchedVenue.address, matchedVenue.city, matchedVenue.state]
                  .filter(Boolean)
                  .join(", ") || "Location details not available"}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Match confidence: {matchedVenue.confidence}%
              </p>
              <Link
                href={`/venues/${matchedVenue.slug}`}
                className="text-sm text-blue-600 hover:underline mt-2 inline-flex items-center"
                target="_blank"
              >
                View venue page
                <ExternalLink className="w-3 h-3 ml-1" />
              </Link>
            </div>

            {alternativeVenues.length > 0 && (
              <div className="mt-4">
                <p className="text-sm text-gray-600 mb-2">Other possible matches:</p>
                <div className="space-y-2">
                  {alternativeVenues.map((venue) => (
                    <button
                      key={venue.id}
                      onClick={() => confirmVenue(venue.id)}
                      className="w-full text-left p-3 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg transition-colors"
                    >
                      <span className="font-medium text-gray-900">{venue.name}</span>
                      <span className="text-sm text-gray-500 ml-2">
                        {venue.city}, {venue.state} ({venue.confidence}%)
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between pt-4 border-t">
              <Button variant="outline" onClick={skipVenueMatch}>
                Skip - Don&apos;t Link Venue
              </Button>
              <Button onClick={() => confirmVenue(matchedVenue.id)}>
                <Check className="w-4 h-4 mr-1" />
                Yes, Link This Venue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Venue Match Loading (checking for matches) */}
      {step === "venue-match" && !matchedVenue && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
            <h3 className="text-lg font-medium text-gray-900">
              Checking for matching venues...
            </h3>
          </CardContent>
        </Card>
      )}

      {/* Step: Review & Edit */}
      {step === "review" && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left: Source Content (hidden on mobile) */}
          <div className="hidden lg:block lg:col-span-2">
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
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                  Event Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Event Name */}
                <div>
                  <Label htmlFor="eventName">
                    Event Name *
                    <ConfidenceBadge field="name" />
                  </Label>
                  <Input
                    id="eventName"
                    autoComplete="off"
                    value={extractedData.name || ""}
                    onChange={(e) =>
                      setExtractedData({ ...extractedData, name: e.target.value })
                    }
                    className="mt-1"
                  />
                </div>

                {/* Description */}
                <div>
                  <Label htmlFor="description">
                    Description
                    <ConfidenceBadge field="description" />
                  </Label>
                  <textarea
                    id="description"
                    className="mt-1 w-full h-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    value={extractedData.description || ""}
                    onChange={(e) =>
                      setExtractedData({
                        ...extractedData,
                        description: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="startDate">
                      Start Date
                      <ConfidenceBadge field="startDate" />
                    </Label>
                    <Input
                      id="startDate"
                      type="date"
                      value={extractedData.startDate?.substring(0, 10) || ""}
                      onChange={(e) =>
                        setExtractedData({
                          ...extractedData,
                          startDate: e.target.value || null,
                        })
                      }
                      className="mt-1"
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
                      value={extractedData.endDate?.substring(0, 10) || ""}
                      onChange={(e) =>
                        setExtractedData({
                          ...extractedData,
                          endDate: e.target.value || null,
                        })
                      }
                      className="mt-1"
                    />
                  </div>
                </div>

                {/* Venue Info */}
                <div className="border-t pt-4 mt-4">
                  <Label className="flex items-center gap-2 mb-3">
                    <MapPin className="w-4 h-4" />
                    Location (optional)
                  </Label>

                  {/* Show linked venue indicator */}
                  {confirmedVenueId && matchedVenue && (
                    <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-green-800">
                          <Check className="w-4 h-4 inline mr-1" />
                          Linked to: {matchedVenue.name}
                        </p>
                        <p className="text-xs text-green-600">
                          {matchedVenue.city}, {matchedVenue.state}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfirmedVenueId(null);
                          setMatchedVenue(null);
                        }}
                        className="text-green-700 hover:text-green-900"
                      >
                        Remove
                      </Button>
                    </div>
                  )}

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
                          setExtractedData({
                            ...extractedData,
                            venueName: e.target.value || null,
                          })
                        }
                        placeholder="e.g., Fairgrounds, Convention Center"
                        className="mt-1"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label htmlFor="venueAddress">
                        Street Address
                        <ConfidenceBadge field="venueAddress" />
                      </Label>
                      <Input
                        id="venueAddress"
                        value={extractedData.venueAddress || ""}
                        onChange={(e) =>
                          setExtractedData({
                            ...extractedData,
                            venueAddress: e.target.value || null,
                          })
                        }
                        placeholder="e.g., 123 Main Street"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="venueCity">
                        City
                        <ConfidenceBadge field="venueCity" />
                      </Label>
                      <Input
                        id="venueCity"
                        value={extractedData.venueCity || ""}
                        onChange={(e) =>
                          setExtractedData({
                            ...extractedData,
                            venueCity: e.target.value || null,
                          })
                        }
                        placeholder="e.g., Portland"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="venueState">
                        State
                        <ConfidenceBadge field="venueState" />
                      </Label>
                      <Input
                        id="venueState"
                        value={extractedData.venueState || ""}
                        onChange={(e) =>
                          setExtractedData({
                            ...extractedData,
                            venueState: e.target.value || null,
                          })
                        }
                        placeholder="e.g., ME"
                        maxLength={2}
                        className="mt-1"
                      />
                    </div>
                  </div>
                </div>

                {/* Ticket Info */}
                <div className="border-t pt-4 mt-4">
                  <Label className="flex items-center gap-2 mb-3">
                    <DollarSign className="w-4 h-4" />
                    Ticket Information (optional)
                  </Label>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <Label htmlFor="ticketPriceMin">Min Price</Label>
                      <div className="relative mt-1">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <Input
                          id="ticketPriceMin"
                          type="number"
                          min="0"
                          step="0.01"
                          value={extractedData.ticketPriceMin ?? ""}
                          onChange={(e) =>
                            setExtractedData({
                              ...extractedData,
                              ticketPriceMin: e.target.value
                                ? parseFloat(e.target.value)
                                : null,
                            })
                          }
                          className="pl-8"
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="ticketPriceMax">Max Price</Label>
                      <div className="relative mt-1">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <Input
                          id="ticketPriceMax"
                          type="number"
                          min="0"
                          step="0.01"
                          value={extractedData.ticketPriceMax ?? ""}
                          onChange={(e) =>
                            setExtractedData({
                              ...extractedData,
                              ticketPriceMax: e.target.value
                                ? parseFloat(e.target.value)
                                : null,
                            })
                          }
                          className="pl-8"
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="ticketUrl">Ticket URL</Label>
                      <Input
                        id="ticketUrl"
                        type="url"
                        value={extractedData.ticketUrl || ""}
                        onChange={(e) =>
                          setExtractedData({
                            ...extractedData,
                            ticketUrl: e.target.value || null,
                          })
                        }
                        className="mt-1"
                        placeholder="https://..."
                      />
                    </div>
                  </div>
                </div>

                {/* Image URL */}
                <div>
                  <Label htmlFor="imageUrl">
                    Event Image URL
                    <ConfidenceBadge field="imageUrl" />
                  </Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      id="imageUrl"
                      type="url"
                      value={extractedData.imageUrl || ""}
                      onChange={(e) =>
                        setExtractedData({
                          ...extractedData,
                          imageUrl: e.target.value || null,
                        })
                      }
                      className="flex-1"
                      placeholder="https://..."
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

                {/* Your Email (optional) */}
                <div className="border-t pt-4 mt-4">
                  <Label htmlFor="suggesterEmail" className="flex items-center gap-2">
                    <Mail className="w-4 h-4" />
                    Your Email (optional)
                  </Label>
                  <Input
                    id="suggesterEmail"
                    type="email"
                    value={suggesterEmail}
                    onChange={(e) => setSuggesterEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="mt-1"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    We&apos;ll notify you when your suggestion is reviewed (optional)
                  </p>
                </div>

                {/* Navigation */}
                <div className="flex justify-between pt-4 border-t">
                  <Button variant="outline" onClick={() => setStep("url-input")}>
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Back
                  </Button>
                  <Button onClick={handleSubmit}>
                    Submit Event
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Step: Submitting */}
      {step === "submitting" && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
            <h3 className="text-lg font-medium text-gray-900">
              Submitting your suggestion...
            </h3>
            <p className="text-gray-500 mt-2">Please wait</p>
          </CardContent>
        </Card>
      )}

      {/* Step: Success */}
      {step === "success" && (
        <Card>
          <CardContent className="py-12">
            <div className="text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">
                Thank You!
              </h3>
              <p className="text-gray-600 mb-6">
                Your event suggestion has been submitted for review.
                {suggesterEmail && " We'll notify you once it's approved."}
              </p>

              {createdEvent && (
                <div className="max-w-md mx-auto mb-6 p-4 bg-gray-50 rounded-lg">
                  <p className="font-medium text-gray-900">{createdEvent.name}</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Your suggestion is now pending admin review.
                  </p>
                </div>
              )}

              <div className="flex justify-center gap-4">
                <Button onClick={resetWizard}>
                  Suggest Another Event
                </Button>
                <Link href="/events">
                  <Button variant="outline">
                    Browse Events
                    <ExternalLink className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
