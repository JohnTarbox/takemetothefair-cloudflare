import { useReducer, useEffect, useMemo, useCallback, useRef } from "react";
import type {
  ExtractedEventData,
  ExtractedEvent,
  FieldConfidence,
  EventConfidence,
  VenueOption,
} from "@/lib/url-import/types";
import { isValidUrl } from "./utils";
import { levenshteinSimilarity } from "@/lib/duplicates/similarity";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";

// --- Types ---

export type WizardStep =
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

export interface Venue {
  id: string;
  name: string;
  city: string;
  state: string;
  address: string;
}

export interface Promoter {
  id: string;
  companyName: string;
}

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

const EMPTY_EXTRACTED_DATA: ExtractedEventData = {
  name: null,
  description: null,
  startDate: null,
  endDate: null,
  startTime: null,
  endTime: null,
  hoursVaryByDay: false,
  hoursNotes: null,
  venueName: null,
  venueAddress: null,
  venueCity: null,
  venueState: null,
  ticketUrl: null,
  ticketPriceMin: null,
  ticketPriceMax: null,
  imageUrl: null,
};

// --- State ---

interface WizardState {
  step: WizardStep;
  error: string;

  // URL input
  url: string;
  manualPaste: boolean;
  pastedContent: string;
  duplicateWarning: { name: string; slug: string } | null;

  // Fetched content
  fetchedContent: string;
  fetchedJsonLd: Record<string, unknown> | null;

  // Multi-event extraction
  extractedEvents: ExtractedEvent[];
  eventConfidence: EventConfidence;
  selectedEventIds: Set<string>;
  currentEventIndex: number;
  eventsToImport: ExtractedEvent[];

  // Current event being edited
  extractedData: ExtractedEventData;
  confidence: FieldConfidence;
  datesConfirmed: boolean;

  // Venue
  venues: Venue[];
  venueOption: VenueOption;
  selectedVenueId: string;
  newVenueName: string;
  newVenueAddress: string;
  newVenueCity: string;
  newVenueState: string;

  // Promoter
  promoters: Promoter[];
  selectedPromoterId: string;

  // Saving progress
  savingProgress: { current: number; total: number } | null;

  // Success
  createdEvents: Array<{ id: string; slug: string; name: string }>;
  batchErrors: Array<{ eventName: string; error: string }>;
}

const initialState: WizardState = {
  step: "url-input",
  error: "",
  url: "",
  manualPaste: false,
  pastedContent: "",
  duplicateWarning: null,
  fetchedContent: "",
  fetchedJsonLd: null,
  extractedEvents: [],
  eventConfidence: {},
  selectedEventIds: new Set(),
  currentEventIndex: 0,
  eventsToImport: [],
  extractedData: { ...EMPTY_EXTRACTED_DATA },
  confidence: {},
  datesConfirmed: true,
  venues: [],
  venueOption: { type: "none" },
  selectedVenueId: "",
  newVenueName: "",
  newVenueAddress: "",
  newVenueCity: "",
  newVenueState: "",
  promoters: [],
  selectedPromoterId: "",
  savingProgress: null,
  createdEvents: [],
  batchErrors: [],
};

// --- Actions ---

type Action =
  | { type: "SET_STEP"; step: WizardStep }
  | { type: "SET_ERROR"; error: string }
  | { type: "SET_URL"; url: string }
  | { type: "SET_DUPLICATE_WARNING"; warning: { name: string; slug: string } | null }
  | { type: "SET_MANUAL_PASTE"; manualPaste: boolean }
  | { type: "SET_PASTED_CONTENT"; pastedContent: string }
  | { type: "FETCH_SUCCESS"; content: string; jsonLd?: Record<string, unknown> | null }
  | {
      type: "EXTRACT_SUCCESS";
      events: ExtractedEvent[];
      confidence: EventConfidence;
    }
  | { type: "EXTRACT_SINGLE"; event: ExtractedEvent; confidence: EventConfidence }
  | { type: "EXTRACT_FAIL"; error: string }
  | { type: "SET_SELECTED_EVENT_IDS"; ids: Set<string> }
  | { type: "TOGGLE_EVENT_SELECTION"; eventId: string }
  | { type: "TOGGLE_SELECT_ALL" }
  | {
      type: "LOAD_EVENT_FOR_REVIEW";
      event: ExtractedEvent;
      confidence: FieldConfidence;
    }
  | { type: "UPDATE_EXTRACTED_DATA"; data: Partial<ExtractedEventData> }
  | { type: "SET_DATES_CONFIRMED"; confirmed: boolean }
  | {
      type: "PROCEED_TO_REVIEW";
      selected: ExtractedEvent[];
      firstEvent: ExtractedEvent;
      firstEventConfidence: FieldConfidence;
    }
  | { type: "SAVE_CURRENT_EVENT_EDITS" }
  | {
      type: "NAVIGATE_EVENT";
      index: number;
      event: ExtractedEvent;
      confidence: FieldConfidence;
    }
  | { type: "SET_EVENTS_TO_IMPORT"; events: ExtractedEvent[] }
  | { type: "SET_VENUE_OPTION"; option: VenueOption }
  | { type: "SET_SELECTED_VENUE_ID"; id: string }
  | { type: "SET_NEW_VENUE"; name: string; address: string; city: string; state: string }
  | { type: "SET_NEW_VENUE_NAME"; name: string }
  | { type: "SET_NEW_VENUE_ADDRESS"; address: string }
  | { type: "SET_NEW_VENUE_CITY"; city: string }
  | { type: "SET_NEW_VENUE_STATE"; state: string }
  | { type: "SET_SELECTED_PROMOTER_ID"; id: string }
  | { type: "SET_VENUES_AND_PROMOTERS"; venues: Venue[]; promoters: Promoter[] }
  | { type: "SET_SAVING_PROGRESS"; current: number; total: number }
  | {
      type: "SAVE_COMPLETE";
      created: Array<{ id: string; slug: string; name: string }>;
      batchErrors: Array<{ eventName: string; error: string }>;
    }
  | { type: "RETRY_FAILED" }
  | { type: "RESET" };

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_URL":
      return { ...state, url: action.url, duplicateWarning: null };
    case "SET_DUPLICATE_WARNING":
      return { ...state, duplicateWarning: action.warning };
    case "SET_MANUAL_PASTE":
      return { ...state, manualPaste: action.manualPaste, pastedContent: action.manualPaste ? state.pastedContent : "" };
    case "SET_PASTED_CONTENT":
      return { ...state, pastedContent: action.pastedContent };
    case "FETCH_SUCCESS":
      return {
        ...state,
        fetchedContent: action.content,
        fetchedJsonLd: action.jsonLd ?? null,
      };
    case "EXTRACT_SUCCESS":
      return {
        ...state,
        extractedEvents: action.events,
        eventConfidence: action.confidence,
        selectedEventIds: new Set(action.events.map((e) => e._extractId)),
        step: "select-events",
      };
    case "EXTRACT_SINGLE": {
      const ev = action.event;
      return {
        ...state,
        extractedEvents: [ev],
        eventConfidence: action.confidence,
        selectedEventIds: new Set([ev._extractId]),
        eventsToImport: [ev],
        currentEventIndex: 0,
        step: "review",
      };
    }
    case "EXTRACT_FAIL":
      return {
        ...state,
        error: action.error,
        extractedEvents: [],
        step: "review",
      };
    case "SET_SELECTED_EVENT_IDS":
      return { ...state, selectedEventIds: action.ids };
    case "TOGGLE_EVENT_SELECTION": {
      const next = new Set(state.selectedEventIds);
      if (next.has(action.eventId)) {
        next.delete(action.eventId);
      } else {
        next.add(action.eventId);
      }
      return { ...state, selectedEventIds: next };
    }
    case "TOGGLE_SELECT_ALL":
      return {
        ...state,
        selectedEventIds:
          state.selectedEventIds.size === state.extractedEvents.length
            ? new Set()
            : new Set(state.extractedEvents.map((e) => e._extractId)),
      };
    case "LOAD_EVENT_FOR_REVIEW":
      return {
        ...state,
        extractedData: {
          name: action.event.name,
          description: action.event.description,
          startDate: action.event.startDate,
          endDate: action.event.endDate,
          startTime: action.event.startTime,
          endTime: action.event.endTime,
          hoursVaryByDay: action.event.hoursVaryByDay,
          hoursNotes: action.event.hoursNotes,
          venueName: action.event.venueName,
          venueAddress: action.event.venueAddress,
          venueCity: action.event.venueCity,
          venueState: action.event.venueState,
          ticketUrl: action.event.ticketUrl,
          ticketPriceMin: action.event.ticketPriceMin,
          ticketPriceMax: action.event.ticketPriceMax,
          imageUrl: action.event.imageUrl,
        },
        confidence: action.confidence,
        datesConfirmed: true,
        newVenueName: action.event.venueName || "",
        newVenueAddress: action.event.venueAddress || "",
        newVenueCity: action.event.venueCity || "",
        newVenueState: action.event.venueState || "",
        selectedVenueId: "",
        venueOption: { type: "none" },
      };
    case "UPDATE_EXTRACTED_DATA":
      return {
        ...state,
        extractedData: { ...state.extractedData, ...action.data },
      };
    case "SET_DATES_CONFIRMED":
      return { ...state, datesConfirmed: action.confirmed };
    case "PROCEED_TO_REVIEW":
      return {
        ...state,
        error: "",
        eventsToImport: action.selected,
        currentEventIndex: 0,
        extractedData: {
          name: action.firstEvent.name,
          description: action.firstEvent.description,
          startDate: action.firstEvent.startDate,
          endDate: action.firstEvent.endDate,
          startTime: action.firstEvent.startTime,
          endTime: action.firstEvent.endTime,
          hoursVaryByDay: action.firstEvent.hoursVaryByDay,
          hoursNotes: action.firstEvent.hoursNotes,
          venueName: action.firstEvent.venueName,
          venueAddress: action.firstEvent.venueAddress,
          venueCity: action.firstEvent.venueCity,
          venueState: action.firstEvent.venueState,
          ticketUrl: action.firstEvent.ticketUrl,
          ticketPriceMin: action.firstEvent.ticketPriceMin,
          ticketPriceMax: action.firstEvent.ticketPriceMax,
          imageUrl: action.firstEvent.imageUrl,
        },
        confidence: action.firstEventConfidence,
        datesConfirmed: true,
        newVenueName: action.firstEvent.venueName || "",
        newVenueAddress: action.firstEvent.venueAddress || "",
        newVenueCity: action.firstEvent.venueCity || "",
        newVenueState: action.firstEvent.venueState || "",
        selectedVenueId: "",
        venueOption: { type: "none" },
        step: "review",
      };
    case "SAVE_CURRENT_EVENT_EDITS": {
      if (state.eventsToImport.length === 0) return state;
      const updated = [...state.eventsToImport];
      updated[state.currentEventIndex] = {
        ...updated[state.currentEventIndex],
        ...state.extractedData,
        _extractId: updated[state.currentEventIndex]._extractId,
      };
      return { ...state, eventsToImport: updated };
    }
    case "NAVIGATE_EVENT":
      return {
        ...state,
        currentEventIndex: action.index,
        extractedData: {
          name: action.event.name,
          description: action.event.description,
          startDate: action.event.startDate,
          endDate: action.event.endDate,
          startTime: action.event.startTime,
          endTime: action.event.endTime,
          hoursVaryByDay: action.event.hoursVaryByDay,
          hoursNotes: action.event.hoursNotes,
          venueName: action.event.venueName,
          venueAddress: action.event.venueAddress,
          venueCity: action.event.venueCity,
          venueState: action.event.venueState,
          ticketUrl: action.event.ticketUrl,
          ticketPriceMin: action.event.ticketPriceMin,
          ticketPriceMax: action.event.ticketPriceMax,
          imageUrl: action.event.imageUrl,
        },
        confidence: action.confidence,
        datesConfirmed: true,
        newVenueName: action.event.venueName || "",
        newVenueAddress: action.event.venueAddress || "",
        newVenueCity: action.event.venueCity || "",
        newVenueState: action.event.venueState || "",
        selectedVenueId: "",
        venueOption: { type: "none" },
      };
    case "SET_EVENTS_TO_IMPORT":
      return { ...state, eventsToImport: action.events };
    case "SET_VENUE_OPTION":
      return { ...state, venueOption: action.option };
    case "SET_SELECTED_VENUE_ID":
      return {
        ...state,
        selectedVenueId: action.id,
        newVenueName: action.id ? "" : state.newVenueName,
      };
    case "SET_NEW_VENUE":
      return {
        ...state,
        newVenueName: action.name,
        newVenueAddress: action.address,
        newVenueCity: action.city,
        newVenueState: action.state,
      };
    case "SET_NEW_VENUE_NAME":
      return {
        ...state,
        newVenueName: action.name,
        selectedVenueId: action.name ? "" : state.selectedVenueId,
      };
    case "SET_NEW_VENUE_ADDRESS":
      return { ...state, newVenueAddress: action.address };
    case "SET_NEW_VENUE_CITY":
      return { ...state, newVenueCity: action.city };
    case "SET_NEW_VENUE_STATE":
      return { ...state, newVenueState: action.state };
    case "SET_SELECTED_PROMOTER_ID":
      return { ...state, selectedPromoterId: action.id };
    case "SET_VENUES_AND_PROMOTERS":
      return { ...state, venues: action.venues, promoters: action.promoters };
    case "SET_SAVING_PROGRESS":
      return { ...state, savingProgress: { current: action.current, total: action.total } };
    case "SAVE_COMPLETE":
      return {
        ...state,
        createdEvents: action.created,
        batchErrors: action.batchErrors,
        error: "",
        savingProgress: null,
        step: "success",
      };
    case "RETRY_FAILED": {
      // Re-run save with only the failed events
      const failedNames = new Set(state.batchErrors.map((e) => e.eventName));
      const failedEvents = state.eventsToImport.filter(
        (e) => failedNames.has(e.name || "Unnamed Event")
      );
      if (failedEvents.length === 0) return state;
      return {
        ...state,
        eventsToImport: failedEvents,
        batchErrors: [],
        error: "",
        step: "saving",
      };
    }
    case "RESET":
      return {
        ...initialState,
        venues: state.venues,
        promoters: state.promoters,
      };
    default:
      return state;
  }
}

// --- Hook ---

export function useImportWizard() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Load venues and promoters on mount
  useEffect(() => {
    (async () => {
      try {
        const [venuesRes, promotersRes] = await Promise.all([
          fetch("/api/admin/venues"),
          fetch("/api/admin/promoters"),
        ]);
        const venues = (await venuesRes.json()) as Venue[];
        const promoters = (await promotersRes.json()) as Promoter[];
        dispatch({ type: "SET_VENUES_AND_PROMOTERS", venues, promoters });
      } catch (err) {
        console.error("Failed to fetch venues/promoters:", err);
      }
    })();
  }, []);

  // Derived: similar venues using Levenshtein fuzzy matching
  const similarVenues = useMemo(() => {
    if (!state.extractedData.venueName) return [];
    const venueName = state.extractedData.venueName;
    const venueCity = state.extractedData.venueCity;

    const scored = state.venues
      .map((v) => {
        let score = levenshteinSimilarity(venueName, v.name, 0.3);
        // Boost score if city matches
        if (venueCity && v.city.toLowerCase() === venueCity.toLowerCase()) {
          score = Math.min(1, score + 0.2);
        }
        return { venue: v, score };
      })
      .filter((item) => item.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return scored.map((item) => item.venue);
  }, [state.extractedData.venueName, state.extractedData.venueCity, state.venues]);

  // --- Actions ---

  const cancelFetch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "SET_STEP", step: "url-input" });
  }, []);

  const handleFetch = useCallback(async () => {
    if (!state.manualPaste && !isValidUrl(state.url)) {
      dispatch({ type: "SET_ERROR", error: "Please enter a valid URL" });
      return;
    }
    dispatch({ type: "SET_ERROR", error: "" });

    // Create new AbortController for this fetch sequence
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    // Check for duplicate URL (non-blocking — shows warning but doesn't prevent import)
    if (!state.manualPaste && state.url) {
      try {
        const dupRes = await fetch(
          `/api/admin/import-url/check-duplicate?url=${encodeURIComponent(state.url)}`,
          { signal }
        );
        const dupData = (await dupRes.json()) as {
          isDuplicate: boolean;
          existingEvent?: { name: string; slug: string };
        };
        if (dupData.isDuplicate && dupData.existingEvent) {
          dispatch({
            type: "SET_DUPLICATE_WARNING",
            warning: dupData.existingEvent,
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Non-blocking: proceed even if duplicate check fails
      }
    }

    if (state.manualPaste) {
      if (!state.pastedContent.trim()) {
        dispatch({ type: "SET_ERROR", error: "Please paste some content" });
        return;
      }

      // Detect HTML content and preprocess: extract metadata + clean text
      const looksLikeHtml = /<(?:html|head|body|meta|div|script)\b/i.test(state.pastedContent);
      let content = state.pastedContent;
      let metadata: { title?: string; description?: string; ogImage?: string; jsonLd?: Record<string, unknown> } | undefined;

      if (looksLikeHtml) {
        const extracted = extractMetadata(state.pastedContent);
        metadata = {
          title: extracted.title,
          description: extracted.description,
          ogImage: extracted.ogImage,
          jsonLd: extracted.jsonLd as Record<string, unknown> | undefined,
        };
        content = extractTextFromHtml(state.pastedContent);
      }

      dispatch({ type: "FETCH_SUCCESS", content, jsonLd: metadata?.jsonLd });
      dispatch({ type: "SET_STEP", step: "extracting" });
      await handleExtract(content, metadata, signal);
      return;
    }

    dispatch({ type: "SET_STEP", step: "fetching" });

    try {
      const res = await fetch(
        `/api/admin/import-url/fetch?url=${encodeURIComponent(state.url)}`,
        { signal }
      );
      const data = (await res.json()) as FetchResponse;

      if (!data.success) {
        dispatch({ type: "SET_ERROR", error: data.error || "Failed to fetch page" });
        dispatch({ type: "SET_STEP", step: "url-input" });
        return;
      }

      dispatch({
        type: "FETCH_SUCCESS",
        content: data.content || "",
        jsonLd: data.jsonLd,
      });
      dispatch({ type: "SET_STEP", step: "extracting" });
      await handleExtract(data.content || "", {
        title: data.title,
        description: data.description,
        ogImage: data.ogImage,
        jsonLd: data.jsonLd,
      }, signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      dispatch({
        type: "SET_ERROR",
        error: "Failed to fetch page. Try pasting the content manually.",
      });
      dispatch({ type: "SET_STEP", step: "url-input" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, state.manualPaste, state.pastedContent]);

  const handleExtract = async (
    content: string,
    metadata?: {
      title?: string;
      description?: string;
      ogImage?: string;
      jsonLd?: Record<string, unknown>;
    },
    signal?: AbortSignal
  ) => {
    try {
      const res = await fetch("/api/admin/import-url/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          url: state.url,
          metadata: metadata || {},
        }),
        signal,
      });
      const data = (await res.json()) as ExtractResponse;

      if (!data.success || !data.events || data.events.length === 0) {
        dispatch({
          type: "EXTRACT_FAIL",
          error: data.error || "No events found. Please add event data manually.",
        });
        return;
      }

      const events = data.events;
      const confidence = data.confidence || {};

      if (events.length === 1) {
        const singleEvent = events[0];
        dispatch({
          type: "EXTRACT_SINGLE",
          event: singleEvent,
          confidence,
        });
        dispatch({
          type: "LOAD_EVENT_FOR_REVIEW",
          event: singleEvent,
          confidence: confidence[singleEvent._extractId] || {},
        });
      } else {
        dispatch({ type: "EXTRACT_SUCCESS", events, confidence });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      dispatch({
        type: "EXTRACT_FAIL",
        error: "Failed to extract event data. Please fill in manually.",
      });
    }
  };

  const handleReExtract = useCallback(async () => {
    if (!state.fetchedContent) return;
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STEP", step: "extracting" });
    await handleExtract(state.fetchedContent);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.fetchedContent]);

  const handleProceedToReview = useCallback(() => {
    if (state.selectedEventIds.size === 0) {
      dispatch({
        type: "SET_ERROR",
        error: "Please select at least one event to import",
      });
      return;
    }

    const selected = state.extractedEvents.filter((e) =>
      state.selectedEventIds.has(e._extractId)
    );
    const firstEvent = selected[0];
    dispatch({
      type: "PROCEED_TO_REVIEW",
      selected,
      firstEvent,
      firstEventConfidence: state.eventConfidence[firstEvent._extractId] || {},
    });
  }, [state.selectedEventIds, state.extractedEvents, state.eventConfidence]);

  const goToVenue = useCallback(() => {
    if (!state.extractedData.name?.trim()) {
      dispatch({ type: "SET_ERROR", error: "Event name is required" });
      return;
    }
    dispatch({ type: "SET_ERROR", error: "" });

    if (state.eventsToImport.length === 0) {
      const singleEvent: ExtractedEvent = {
        ...state.extractedData,
        _extractId: "manual-" + Date.now(),
      };
      dispatch({ type: "SET_EVENTS_TO_IMPORT", events: [singleEvent] });
    } else {
      dispatch({ type: "SAVE_CURRENT_EVENT_EDITS" });
    }

    // Sync extracted venue data to form fields
    if (state.extractedData.venueName && !state.newVenueName) {
      dispatch({
        type: "SET_NEW_VENUE",
        name: state.extractedData.venueName,
        address: state.extractedData.venueAddress || "",
        city: state.extractedData.venueCity || "",
        state: state.extractedData.venueState || "",
      });
    }
    dispatch({ type: "SET_STEP", step: "venue" });
  }, [state.extractedData, state.eventsToImport.length, state.newVenueName]);

  const goToNextEvent = useCallback(() => {
    if (!state.extractedData.name?.trim()) {
      dispatch({ type: "SET_ERROR", error: "Event name is required" });
      return;
    }
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SAVE_CURRENT_EVENT_EDITS" });

    if (state.currentEventIndex < state.eventsToImport.length - 1) {
      const nextIndex = state.currentEventIndex + 1;
      const nextEvent = state.eventsToImport[nextIndex];
      dispatch({
        type: "NAVIGATE_EVENT",
        index: nextIndex,
        event: nextEvent,
        confidence: state.eventConfidence[nextEvent._extractId] || {},
      });
    } else {
      dispatch({ type: "SET_STEP", step: "promoter" });
    }
  }, [state.extractedData.name, state.currentEventIndex, state.eventsToImport, state.eventConfidence]);

  const goToPreviousEvent = useCallback(() => {
    dispatch({ type: "SAVE_CURRENT_EVENT_EDITS" });

    if (state.currentEventIndex > 0) {
      const prevIndex = state.currentEventIndex - 1;
      const prevEvent = state.eventsToImport[prevIndex];
      dispatch({
        type: "NAVIGATE_EVENT",
        index: prevIndex,
        event: prevEvent,
        confidence: state.eventConfidence[prevEvent._extractId] || {},
      });
    } else if (state.extractedEvents.length > 1) {
      dispatch({ type: "SET_STEP", step: "select-events" });
    } else {
      dispatch({ type: "SET_STEP", step: "url-input" });
    }
  }, [state.currentEventIndex, state.eventsToImport, state.eventConfidence, state.extractedEvents.length]);

  const goToPromoter = useCallback(() => {
    if (state.selectedVenueId) {
      dispatch({
        type: "SET_VENUE_OPTION",
        option: { type: "existing", id: state.selectedVenueId },
      });
    } else if (state.newVenueName.trim()) {
      dispatch({
        type: "SET_VENUE_OPTION",
        option: {
          type: "new",
          name: state.newVenueName.trim(),
          address: state.newVenueAddress.trim(),
          city: state.newVenueCity.trim(),
          state: state.newVenueState.trim(),
        },
      });
    } else {
      dispatch({ type: "SET_VENUE_OPTION", option: { type: "none" } });
    }
    dispatch({ type: "SET_STEP", step: "promoter" });
  }, [state.selectedVenueId, state.newVenueName, state.newVenueAddress, state.newVenueCity, state.newVenueState]);

  const goToPreview = useCallback(() => {
    if (!state.selectedPromoterId) {
      dispatch({ type: "SET_ERROR", error: "Please select a promoter" });
      return;
    }
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STEP", step: "preview" });
  }, [state.selectedPromoterId]);

  const goBackFromPromoter = useCallback(() => {
    if (state.eventsToImport.length > 1) {
      const lastIndex = state.eventsToImport.length - 1;
      const lastEvent = state.eventsToImport[lastIndex];
      dispatch({
        type: "NAVIGATE_EVENT",
        index: lastIndex,
        event: lastEvent,
        confidence: state.eventConfidence[lastEvent._extractId] || {},
      });
      dispatch({ type: "SET_STEP", step: "review" });
    } else {
      dispatch({ type: "SET_STEP", step: "venue" });
    }
  }, [state.eventsToImport, state.eventConfidence]);

  const handleSave = useCallback(async () => {
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STEP", step: "saving" });

    const created: Array<{ id: string; slug: string; name: string }> = [];
    const batchErrors: Array<{ eventName: string; error: string }> = [];
    let currentVenueOption: VenueOption = state.venueOption;
    const total = state.eventsToImport.length;

    for (let idx = 0; idx < state.eventsToImport.length; idx++) {
      const event = state.eventsToImport[idx];
      dispatch({ type: "SET_SAVING_PROGRESS", current: idx + 1, total });
      try {
        const res = await fetch("/api/admin/import-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: {
              ...event,
              datesConfirmed: state.datesConfirmed,
            },
            venueOption: currentVenueOption,
            promoterId: state.selectedPromoterId,
            sourceUrl: state.url || null,
            jsonLd: state.fetchedJsonLd,
          }),
        });

        const data = (await res.json()) as ImportResponse;

        if (data.success && data.event) {
          created.push({
            id: data.event.id,
            slug: data.event.slug,
            name: event.name || "Unnamed Event",
          });
          if (currentVenueOption.type === "new" && data.venueId) {
            currentVenueOption = { type: "existing", id: data.venueId };
          }
        } else {
          batchErrors.push({
            eventName: event.name || "Unnamed Event",
            error: data.error || "Failed to save",
          });
        }
      } catch {
        batchErrors.push({
          eventName: event.name || "Unnamed Event",
          error: "Network error",
        });
      }
    }

    dispatch({
      type: "SAVE_COMPLETE",
      created,
      batchErrors,
    });
  }, [state.venueOption, state.eventsToImport, state.datesConfirmed, state.selectedPromoterId, state.url, state.fetchedJsonLd]);

  const retryFailed = useCallback(async () => {
    dispatch({ type: "RETRY_FAILED" });
    // The retry will be triggered by handleSave when state updates
    // We need to immediately kick off save with the failed events
    const failedNames = new Set(state.batchErrors.map((e) => e.eventName));
    const failedEvents = state.eventsToImport.filter(
      (e) => failedNames.has(e.name || "Unnamed Event")
    );
    if (failedEvents.length === 0) return;

    dispatch({ type: "SET_STEP", step: "saving" });
    const created: Array<{ id: string; slug: string; name: string }> = [
      ...state.createdEvents,
    ];
    const batchErrors: Array<{ eventName: string; error: string }> = [];
    let currentVenueOption: VenueOption = state.venueOption;
    const total = failedEvents.length;

    for (let idx = 0; idx < failedEvents.length; idx++) {
      const event = failedEvents[idx];
      dispatch({ type: "SET_SAVING_PROGRESS", current: idx + 1, total });
      try {
        const res = await fetch("/api/admin/import-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: { ...event, datesConfirmed: state.datesConfirmed },
            venueOption: currentVenueOption,
            promoterId: state.selectedPromoterId,
            sourceUrl: state.url || null,
            jsonLd: state.fetchedJsonLd,
          }),
        });
        const data = (await res.json()) as ImportResponse;
        if (data.success && data.event) {
          created.push({
            id: data.event.id,
            slug: data.event.slug,
            name: event.name || "Unnamed Event",
          });
          if (currentVenueOption.type === "new" && data.venueId) {
            currentVenueOption = { type: "existing", id: data.venueId };
          }
        } else {
          batchErrors.push({
            eventName: event.name || "Unnamed Event",
            error: data.error || "Failed to save",
          });
        }
      } catch {
        batchErrors.push({
          eventName: event.name || "Unnamed Event",
          error: "Network error",
        });
      }
    }

    dispatch({ type: "SAVE_COMPLETE", created, batchErrors });
  }, [state.batchErrors, state.eventsToImport, state.createdEvents, state.venueOption, state.datesConfirmed, state.selectedPromoterId, state.url, state.fetchedJsonLd]);

  const resetWizard = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return {
    state,
    dispatch,
    similarVenues,
    // Actions
    handleFetch,
    cancelFetch,
    handleReExtract,
    handleProceedToReview,
    goToVenue,
    goToNextEvent,
    goToPreviousEvent,
    goToPromoter,
    goToPreview,
    goBackFromPromoter,
    handleSave,
    retryFailed,
    resetWizard,
  };
}
