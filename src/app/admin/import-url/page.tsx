"use client";

import { useState, useEffect } from "react";
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
  ChevronRight,
  ChevronLeft,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  ExtractedEventData,
  ExtractedEvent,
  FieldConfidence,
  EventConfidence,
  VenueOption,
} from "@/lib/url-import/types";

export const runtime = "edge";

type WizardStep =
  | "url-input"
  | "fetching"
  | "extracting"
  | "select-events"
  | "review"
  | "venue"
  | "promoter"
  | "preview"
  | "saving"
  | "success";

interface Venue {
  id: string;
  name: string;
  city: string;
  state: string;
  address: string;
}

interface Promoter {
  id: string;
  companyName: string;
}

// API response types
interface FetchResponse {
  success: boolean;
  content?: string;
  title?: string;
  description?: string;
  ogImage?: string;
  jsonLd?: Record<string, unknown>;
  error?: string;
}

interface ExtractResponse {
  success: boolean;
  events?: ExtractedEvent[];
  confidence?: EventConfidence;
  error?: string;
}

interface ImportResponse {
  success: boolean;
  event?: { id: string; slug: string };
  venueId?: string;
  error?: string;
}

export default function ImportUrlPage() {
  // Wizard state
  const [step, setStep] = useState<WizardStep>("url-input");
  const [error, setError] = useState("");

  // URL input state
  const [url, setUrl] = useState("");
  const [manualPaste, setManualPaste] = useState(false);
  const [pastedContent, setPastedContent] = useState("");

  // Fetched content state
  const [fetchedContent, setFetchedContent] = useState("");
  const [_pageTitle, setPageTitle] = useState("");
  const [_ogImage, setOgImage] = useState("");
  const [fetchedJsonLd, setFetchedJsonLd] = useState<Record<string, unknown> | null>(null);

  // Multi-event extraction state
  const [extractedEvents, setExtractedEvents] = useState<ExtractedEvent[]>([]);
  const [eventConfidence, setEventConfidence] = useState<EventConfidence>({});
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [eventsToImport, setEventsToImport] = useState<ExtractedEvent[]>([]);

  // Current event being edited (for review step)
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
  const [datesConfirmed, setDatesConfirmed] = useState(true);

  // Venue state
  const [venues, setVenues] = useState<Venue[]>([]);
  const [venueOption, setVenueOption] = useState<VenueOption>({ type: "none" });
  const [selectedVenueId, setSelectedVenueId] = useState("");
  const [newVenueName, setNewVenueName] = useState("");
  const [newVenueAddress, setNewVenueAddress] = useState("");
  const [newVenueCity, setNewVenueCity] = useState("");
  const [newVenueState, setNewVenueState] = useState("");

  // Promoter state
  const [promoters, setPromoters] = useState<Promoter[]>([]);
  const [selectedPromoterId, setSelectedPromoterId] = useState("");

  // Success state
  const [createdEvents, setCreatedEvents] = useState<Array<{
    id: string;
    slug: string;
    name: string;
  }>>([]);

  // Load venues and promoters on mount
  useEffect(() => {
    fetchVenuesAndPromoters();
  }, []);

  const fetchVenuesAndPromoters = async () => {
    try {
      const [venuesRes, promotersRes] = await Promise.all([
        fetch("/api/admin/venues"),
        fetch("/api/admin/promoters"),
      ]);
      const venuesData = (await venuesRes.json()) as Venue[];
      const promotersData = (await promotersRes.json()) as Promoter[];
      setVenues(venuesData);
      setPromoters(promotersData);
    } catch (err) {
      console.error("Failed to fetch venues/promoters:", err);
    }
  };

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
      // Use pasted content directly
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
        `/api/admin/import-url/fetch?url=${encodeURIComponent(url)}`
      );
      const data = (await res.json()) as FetchResponse;

      if (!data.success) {
        setError(data.error || "Failed to fetch page");
        setStep("url-input");
        return;
      }

      setFetchedContent(data.content || "");
      setPageTitle(data.title || "");
      setOgImage(data.ogImage || "");
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

  // Step: AI Extract (multi-event)
  const handleExtract = async (
    content: string,
    metadata?: { title?: string; description?: string; ogImage?: string; jsonLd?: Record<string, unknown> }
  ) => {
    try {
      const res = await fetch("/api/admin/import-url/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          url,
          metadata: metadata || {},
        }),
      });
      const data = (await res.json()) as ExtractResponse;

      if (!data.success || !data.events || data.events.length === 0) {
        // No events found - go to review with empty form for manual entry
        setError(data.error || "No events found. Please add event data manually.");
        setExtractedEvents([]);
        setStep("review");
        return;
      }

      const events = data.events;
      const confidence = data.confidence || {};

      // Store all extracted events
      setExtractedEvents(events);
      setEventConfidence(confidence);

      // If only one event, skip selection step and go directly to review
      if (events.length === 1) {
        const singleEvent = events[0];
        setSelectedEventIds(new Set([singleEvent._extractId]));
        setEventsToImport([singleEvent]);
        setCurrentEventIndex(0);
        loadEventForReview(singleEvent, confidence[singleEvent._extractId] || {});
        setStep("review");
      } else {
        // Multiple events - show selection step
        // Pre-select all events by default
        const allIds = new Set(events.map((e) => e._extractId));
        setSelectedEventIds(allIds);
        setStep("select-events");
      }
    } catch {
      setError("Failed to extract event data. Please fill in manually.");
      setStep("review");
    }
  };

  // Load an event into the review form
  const loadEventForReview = (event: ExtractedEvent, eventConf: FieldConfidence) => {
    setExtractedData({
      name: event.name,
      description: event.description,
      startDate: event.startDate,
      endDate: event.endDate,
      venueName: event.venueName,
      venueAddress: event.venueAddress,
      venueCity: event.venueCity,
      venueState: event.venueState,
      ticketUrl: event.ticketUrl,
      ticketPriceMin: event.ticketPriceMin,
      ticketPriceMax: event.ticketPriceMax,
      imageUrl: event.imageUrl,
    });
    setConfidence(eventConf);
    setDatesConfirmed(true);

    // Pre-fill venue fields
    if (event.venueName) {
      setNewVenueName(event.venueName);
      setNewVenueAddress(event.venueAddress || "");
      setNewVenueCity(event.venueCity || "");
      setNewVenueState(event.venueState || "");
    } else {
      setNewVenueName("");
      setNewVenueAddress("");
      setNewVenueCity("");
      setNewVenueState("");
    }
    setSelectedVenueId("");
    setVenueOption({ type: "none" });
  };

  // Proceed from event selection to review
  const handleProceedToReview = () => {
    if (selectedEventIds.size === 0) {
      setError("Please select at least one event to import");
      return;
    }
    setError("");

    // Build the list of events to import
    const selected = extractedEvents.filter(e => selectedEventIds.has(e._extractId));
    setEventsToImport(selected);
    setCurrentEventIndex(0);

    // Load the first event for review
    const firstEvent = selected[0];
    loadEventForReview(firstEvent, eventConfidence[firstEvent._extractId] || {});
    setStep("review");
  };

  // Toggle event selection
  const toggleEventSelection = (eventId: string) => {
    setSelectedEventIds(prev => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  // Select/deselect all events
  const toggleSelectAll = () => {
    if (selectedEventIds.size === extractedEvents.length) {
      setSelectedEventIds(new Set());
    } else {
      setSelectedEventIds(new Set(extractedEvents.map(e => e._extractId)));
    }
  };

  // Save current event's edits back to eventsToImport array
  const saveCurrentEventEdits = () => {
    if (eventsToImport.length === 0) return;

    setEventsToImport(prev => {
      const updated = [...prev];
      updated[currentEventIndex] = {
        ...updated[currentEventIndex],
        ...extractedData,
        _extractId: updated[currentEventIndex]._extractId,
      };
      return updated;
    });
  };

  // Navigate between steps
  const goToVenue = () => {
    if (!extractedData.name?.trim()) {
      setError("Event name is required");
      return;
    }
    setError("");

    // For single event flow, ensure eventsToImport has the current data
    if (eventsToImport.length === 0) {
      // Manual entry or single event that didn't go through selection
      const singleEvent: ExtractedEvent = {
        ...extractedData,
        _extractId: "manual-" + Date.now(),
      };
      setEventsToImport([singleEvent]);
    } else {
      // Save current event edits
      saveCurrentEventEdits();
    }

    // Sync extracted venue data to form fields
    if (extractedData.venueName && !newVenueName) {
      setNewVenueName(extractedData.venueName);
    }
    if (extractedData.venueAddress && !newVenueAddress) {
      setNewVenueAddress(extractedData.venueAddress);
    }
    if (extractedData.venueCity && !newVenueCity) {
      setNewVenueCity(extractedData.venueCity);
    }
    if (extractedData.venueState && !newVenueState) {
      setNewVenueState(extractedData.venueState);
    }
    setStep("venue");
  };

  // Go to next event in the review queue or proceed to promoter
  const goToNextEvent = () => {
    if (!extractedData.name?.trim()) {
      setError("Event name is required");
      return;
    }
    setError("");

    // Save current event edits
    saveCurrentEventEdits();

    if (currentEventIndex < eventsToImport.length - 1) {
      // Load next event for review
      const nextIndex = currentEventIndex + 1;
      setCurrentEventIndex(nextIndex);
      const nextEvent = eventsToImport[nextIndex];
      loadEventForReview(nextEvent, eventConfidence[nextEvent._extractId] || {});
    } else {
      // All events reviewed, go to promoter selection
      setStep("promoter");
    }
  };

  // Go back to previous event in review
  const goToPreviousEvent = () => {
    // Save current edits first
    saveCurrentEventEdits();

    if (currentEventIndex > 0) {
      const prevIndex = currentEventIndex - 1;
      setCurrentEventIndex(prevIndex);
      const prevEvent = eventsToImport[prevIndex];
      loadEventForReview(prevEvent, eventConfidence[prevEvent._extractId] || {});
    } else if (extractedEvents.length > 1) {
      // Go back to event selection
      setStep("select-events");
    } else {
      // Single event or manual - go back to URL input
      setStep("url-input");
    }
  };

  const goToPromoter = () => {
    // Build venue option based on selection
    if (selectedVenueId) {
      setVenueOption({ type: "existing", id: selectedVenueId });
    } else if (newVenueName.trim()) {
      setVenueOption({
        type: "new",
        name: newVenueName.trim(),
        address: newVenueAddress.trim(),
        city: newVenueCity.trim(),
        state: newVenueState.trim(),
      });
    } else {
      setVenueOption({ type: "none" });
    }
    setStep("promoter");
  };

  const goToPreview = () => {
    if (!selectedPromoterId) {
      setError("Please select a promoter");
      return;
    }
    setError("");
    setStep("preview");
  };

  // Save all events (batch)
  const handleSave = async () => {
    setError("");
    setStep("saving");

    const created: Array<{ id: string; slug: string; name: string }> = [];
    const errors: string[] = [];

    // Track venue option - may change after first event creates a new venue
    let currentVenueOption: VenueOption = venueOption;

    // Save each event
    for (const event of eventsToImport) {
      try {
        const res = await fetch("/api/admin/import-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: {
              ...event,
              datesConfirmed,
            },
            venueOption: currentVenueOption,
            promoterId: selectedPromoterId,
            sourceUrl: url || null,
            jsonLd: fetchedJsonLd, // Pass JSON-LD for schema.org storage
          }),
        });

        const data = (await res.json()) as ImportResponse;

        if (data.success && data.event) {
          created.push({
            id: data.event.id,
            slug: data.event.slug,
            name: event.name || "Unnamed Event",
          });
          // After first event creates a venue, use that venue for subsequent events
          if (currentVenueOption.type === "new" && data.venueId) {
            currentVenueOption = { type: "existing", id: data.venueId };
          }
        } else {
          errors.push(`${event.name}: ${data.error || "Failed to save"}`);
        }
      } catch {
        errors.push(`${event.name}: Network error`);
      }
    }

    setCreatedEvents(created);

    if (errors.length > 0) {
      setError(`Some events failed to import: ${errors.join("; ")}`);
    }

    setStep("success");
  };

  // Reset wizard
  const resetWizard = () => {
    setStep("url-input");
    setUrl("");
    setManualPaste(false);
    setPastedContent("");
    setFetchedContent("");
    setPageTitle("");
    setOgImage("");
    // Reset multi-event state
    setExtractedEvents([]);
    setEventConfidence({});
    setSelectedEventIds(new Set());
    setCurrentEventIndex(0);
    setEventsToImport([]);
    // Reset current event state
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
    setDatesConfirmed(true);
    setVenueOption({ type: "none" });
    setSelectedVenueId("");
    setNewVenueName("");
    setNewVenueAddress("");
    setNewVenueCity("");
    setNewVenueState("");
    setSelectedPromoterId("");
    setCreatedEvents([]);
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

  // Find similar venues for matching
  const findSimilarVenues = (): Venue[] => {
    if (!extractedData.venueName) return [];

    const searchTerm = extractedData.venueName.toLowerCase();
    return venues.filter(
      (v) =>
        v.name.toLowerCase().includes(searchTerm) ||
        searchTerm.includes(v.name.toLowerCase()) ||
        (extractedData.venueCity &&
          v.city.toLowerCase() === extractedData.venueCity.toLowerCase())
    );
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/admin"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Admin
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Import from URL</h1>
          <p className="text-gray-600 mt-1">
            Import event details from any webpage using AI extraction
          </p>
        </div>
      </div>

      {/* Tip for supported sources */}
      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-sm">
        <p className="text-blue-800">
          <strong>Tip:</strong> For pages with many events from supported sources
          (fairsandfestivals.net, mainefairs.net, etc.), use the{" "}
          <Link href="/admin/import" className="underline font-medium hover:text-blue-900">
            Bulk Import page
          </Link>{" "}
          instead. It uses dedicated scrapers that can import all events without AI limitations.
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
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

      {/* Step: Select Events (multi-event) */}
      {step === "select-events" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-600" />
              {extractedEvents.length} Events Found
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600">
              Select the events you want to import. You&apos;ll be able to review and edit each one before saving.
            </p>

            {/* Select All / Deselect All */}
            <div className="flex items-center gap-4 pb-3 border-b">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedEventIds.size === extractedEvents.length}
                  onChange={toggleSelectAll}
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
                    onChange={() => toggleEventSelection(event._extractId)}
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
              <Button variant="outline" onClick={() => setStep("url-input")}>
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button
                onClick={handleProceedToReview}
                disabled={selectedEventIds.size === 0}
              >
                Review Selected Events ({selectedEventIds.size})
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Review & Edit */}
      {step === "review" && (
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
                  {eventsToImport.length > 1 && (
                    <span className="text-sm font-normal text-gray-500">
                      Review and edit each event
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Event Name */}
                <div>
                  <Label htmlFor="name">
                    Event Name *
                    <ConfidenceBadge field="name" />
                  </Label>
                  <Input
                    id="name"
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

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={datesConfirmed}
                    onChange={(e) => setDatesConfirmed(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Dates are confirmed
                </label>

                {/* Ticket Info */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-1">
                    <Label htmlFor="ticketPriceMin">
                      Min Price
                      <ConfidenceBadge field="ticketPriceMin" />
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
                  <div className="col-span-1">
                    <Label htmlFor="ticketPriceMax">
                      Max Price
                      <ConfidenceBadge field="ticketPriceMax" />
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
                  <div className="col-span-1">
                    <Label htmlFor="ticketUrl">
                      Ticket URL
                      <ConfidenceBadge field="ticketUrl" />
                    </Label>
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
                    />
                  </div>
                </div>

                {/* Image URL */}
                <div>
                  <Label htmlFor="imageUrl">
                    Image URL
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

                {/* Navigation */}
                <div className="flex justify-between pt-4 border-t">
                  <Button variant="outline" onClick={goToPreviousEvent}>
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    {currentEventIndex > 0
                      ? "Previous Event"
                      : extractedEvents.length > 1
                      ? "Back to Selection"
                      : "Back"}
                  </Button>
                  {eventsToImport.length > 1 ? (
                    <Button onClick={goToNextEvent}>
                      {currentEventIndex < eventsToImport.length - 1
                        ? "Next Event"
                        : "Continue to Promoter"}
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  ) : (
                    <Button onClick={goToVenue}>
                      Continue to Venue
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Step: Venue Selection */}
      {step === "venue" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5" />
              Venue Selection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Extracted venue info */}
            {extractedData.venueName && (
              <div className="p-4 bg-purple-50 rounded-lg">
                <p className="text-sm font-medium text-purple-900 mb-1">
                  AI Extracted Venue:
                </p>
                <p className="text-purple-800">
                  {extractedData.venueName}
                  {extractedData.venueCity && `, ${extractedData.venueCity}`}
                  {extractedData.venueState && `, ${extractedData.venueState}`}
                </p>
                {extractedData.venueAddress && (
                  <p className="text-sm text-purple-700 mt-1">
                    {extractedData.venueAddress}
                  </p>
                )}
              </div>
            )}

            {/* Similar venues */}
            {findSimilarVenues().length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">
                  Matching Existing Venues:
                </p>
                <div className="space-y-2">
                  {findSimilarVenues().map((venue) => (
                    <label
                      key={venue.id}
                      className={`flex items-center p-3 border rounded-lg cursor-pointer transition-colors ${
                        selectedVenueId === venue.id
                          ? "border-blue-500 bg-blue-50"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="venueSelection"
                        checked={selectedVenueId === venue.id}
                        onChange={() => {
                          setSelectedVenueId(venue.id);
                          setNewVenueName("");
                        }}
                        className="mr-3"
                      />
                      <div>
                        <span className="font-medium">{venue.name}</span>
                        <span className="text-sm text-gray-500 ml-2">
                          {venue.city}, {venue.state}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* All venues dropdown */}
            <div>
              <Label htmlFor="venueSelect">Or Select from All Venues</Label>
              <select
                id="venueSelect"
                value={selectedVenueId}
                onChange={(e) => {
                  setSelectedVenueId(e.target.value);
                  if (e.target.value) setNewVenueName("");
                }}
                className="mt-1 w-full h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Select a venue...</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name} ({venue.city}, {venue.state})
                  </option>
                ))}
              </select>
            </div>

            {/* Create new venue */}
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-gray-700 mb-3">
                Or Create New Venue:
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="newVenueName">Venue Name</Label>
                  <Input
                    id="newVenueName"
                    value={newVenueName}
                    onChange={(e) => {
                      setNewVenueName(e.target.value);
                      if (e.target.value) setSelectedVenueId("");
                    }}
                    placeholder="Enter venue name"
                    className="mt-1"
                  />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="newVenueAddress">Address</Label>
                  <Input
                    id="newVenueAddress"
                    value={newVenueAddress}
                    onChange={(e) => setNewVenueAddress(e.target.value)}
                    placeholder="Street address"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="newVenueCity">City</Label>
                  <Input
                    id="newVenueCity"
                    value={newVenueCity}
                    onChange={(e) => setNewVenueCity(e.target.value)}
                    placeholder="City"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="newVenueState">State</Label>
                  <Input
                    id="newVenueState"
                    value={newVenueState}
                    onChange={(e) => setNewVenueState(e.target.value)}
                    placeholder="e.g., MA"
                    maxLength={2}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Skip venue option */}
            <label className="flex items-center gap-2 text-sm text-gray-600 pt-2">
              <input
                type="checkbox"
                checked={!selectedVenueId && !newVenueName}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedVenueId("");
                    setNewVenueName("");
                  }
                }}
                className="rounded border-gray-300"
              />
              Skip venue (create event without venue)
            </label>

            {/* Navigation */}
            <div className="flex justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep("review")}>
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button onClick={goToPromoter}>
                Continue to Promoter
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Promoter Selection */}
      {step === "promoter" && (
        <Card>
          <CardHeader>
            <CardTitle>Select Promoter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {eventsToImport.length > 1 && (
              <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
                You are importing <strong>{eventsToImport.length} events</strong>.
                All events will be assigned to the selected promoter.
              </div>
            )}

            <div>
              <Label htmlFor="promoterId">Promoter *</Label>
              <select
                id="promoterId"
                value={selectedPromoterId}
                onChange={(e) => setSelectedPromoterId(e.target.value)}
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
                {eventsToImport.length > 1
                  ? "All events will be assigned to this promoter."
                  : "The event will be assigned to this promoter."}
              </p>
            </div>

            {/* Navigation */}
            <div className="flex justify-between pt-4 border-t">
              <Button
                variant="outline"
                onClick={() => {
                  if (eventsToImport.length > 1) {
                    // Go back to last event in review
                    setCurrentEventIndex(eventsToImport.length - 1);
                    const lastEvent = eventsToImport[eventsToImport.length - 1];
                    loadEventForReview(lastEvent, eventConfidence[lastEvent._extractId] || {});
                    setStep("review");
                  } else {
                    setStep("venue");
                  }
                }}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button onClick={goToPreview}>
                {eventsToImport.length > 1
                  ? `Preview ${eventsToImport.length} Events`
                  : "Preview Event"}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Preview */}
      {step === "preview" && (
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
                  <div className="pt-4 border-t">
                    <p className="text-xs text-gray-500">
                      Source:{" "}
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {new URL(url).hostname}
                        <ExternalLink className="w-3 h-3 inline ml-1" />
                      </a>
                    </p>
                  </div>
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
                      <span className="ml-2 text-xs text-orange-600">(Tentative)</span>
                    )}
                  </div>

                  {/* Venue */}
                  {(venueOption.type === "existing" || venueOption.type === "new") && (
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
                      <p className="text-xs text-gray-500">
                        Source:{" "}
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {new URL(url).hostname}
                          <ExternalLink className="w-3 h-3 inline ml-1" />
                        </a>
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Navigation */}
            <div className="flex justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep("promoter")}>
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>
              <Button onClick={handleSave}>
                <Check className="w-4 h-4 mr-1" />
                {eventsToImport.length > 1
                  ? `Import ${eventsToImport.length} Events`
                  : "Import Event"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Saving */}
      {step === "saving" && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
            <h3 className="text-lg font-medium text-gray-900">
              Importing {eventsToImport.length > 1 ? `${eventsToImport.length} events` : "event"}...
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
                {createdEvents.length > 1
                  ? `${createdEvents.length} Events Imported Successfully!`
                  : "Event Imported Successfully!"}
              </h3>
              <p className="text-gray-600 mb-6">
                {createdEvents.length > 1
                  ? "All events have been created and are now live."
                  : createdEvents[0]?.name
                  ? `${createdEvents[0].name} has been created and is now live.`
                  : "The event has been created and is now live."}
              </p>
            </div>

            {/* List of created events */}
            {createdEvents.length > 0 && (
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
              <Button onClick={resetWizard}>Import Another</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
