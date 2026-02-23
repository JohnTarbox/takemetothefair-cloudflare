"use client";

import Link from "next/link";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { useImportWizard } from "./use-import-wizard";
import { StepIndicator } from "./components/StepIndicator";
import { UrlInputStep } from "./components/UrlInputStep";
import { LoadingStep } from "./components/LoadingStep";
import { SelectEventsStep } from "./components/SelectEventsStep";
import { ReviewStep } from "./components/ReviewStep";
import { VenueStep } from "./components/VenueStep";
import { PromoterStep } from "./components/PromoterStep";
import { PreviewStep } from "./components/PreviewStep";
import { SavingStep } from "./components/SavingStep";
import { SuccessStep } from "./components/SuccessStep";

export const runtime = "edge";

export default function ImportUrlPage() {
  const {
    state,
    dispatch,
    similarVenues,
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
  } = useImportWizard();

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

      {/* Step Indicator */}
      <StepIndicator currentStep={state.step} />

      {/* Tip for supported sources */}
      {state.step === "url-input" && (
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
      )}

      {/* Error Display */}
      {state.error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {state.error}
        </div>
      )}

      {/* Step Router */}
      {state.step === "url-input" && (
        <UrlInputStep
          url={state.url}
          manualPaste={state.manualPaste}
          pastedContent={state.pastedContent}
          duplicateWarning={state.duplicateWarning}
          onUrlChange={(url) => dispatch({ type: "SET_URL", url })}
          onManualPasteChange={(enabled) =>
            dispatch({ type: "SET_MANUAL_PASTE", manualPaste: enabled })
          }
          onPastedContentChange={(content) =>
            dispatch({ type: "SET_PASTED_CONTENT", pastedContent: content })
          }
          onFetch={handleFetch}
        />
      )}

      {state.step === "fetching" && <LoadingStep variant="fetching" onCancel={cancelFetch} />}
      {state.step === "extracting" && <LoadingStep variant="extracting" onCancel={cancelFetch} />}

      {state.step === "select-events" && (
        <SelectEventsStep
          extractedEvents={state.extractedEvents}
          selectedEventIds={state.selectedEventIds}
          onToggleEvent={(id) =>
            dispatch({ type: "TOGGLE_EVENT_SELECTION", eventId: id })
          }
          onToggleSelectAll={() => dispatch({ type: "TOGGLE_SELECT_ALL" })}
          onProceedToReview={handleProceedToReview}
          onBack={() => dispatch({ type: "SET_STEP", step: "url-input" })}
        />
      )}

      {state.step === "review" && (
        <ReviewStep
          fetchedContent={state.fetchedContent}
          extractedData={state.extractedData}
          confidence={state.confidence}
          datesConfirmed={state.datesConfirmed}
          eventsToImport={state.eventsToImport}
          currentEventIndex={state.currentEventIndex}
          extractedEventsCount={state.extractedEvents.length}
          onUpdateData={(data) =>
            dispatch({ type: "UPDATE_EXTRACTED_DATA", data })
          }
          onSetDatesConfirmed={(confirmed) =>
            dispatch({ type: "SET_DATES_CONFIRMED", confirmed })
          }
          onGoToPreviousEvent={goToPreviousEvent}
          onGoToNextEvent={goToNextEvent}
          onGoToVenue={goToVenue}
          onReExtract={state.fetchedContent ? handleReExtract : undefined}
        />
      )}

      {state.step === "venue" && (
        <VenueStep
          extractedData={state.extractedData}
          venues={state.venues}
          similarVenues={similarVenues}
          selectedVenueId={state.selectedVenueId}
          newVenueName={state.newVenueName}
          newVenueAddress={state.newVenueAddress}
          newVenueCity={state.newVenueCity}
          newVenueState={state.newVenueState}
          onSelectVenue={(id) =>
            dispatch({ type: "SET_SELECTED_VENUE_ID", id })
          }
          onNewVenueName={(name) =>
            dispatch({ type: "SET_NEW_VENUE_NAME", name })
          }
          onNewVenueAddress={(address) =>
            dispatch({ type: "SET_NEW_VENUE_ADDRESS", address })
          }
          onNewVenueCity={(city) =>
            dispatch({ type: "SET_NEW_VENUE_CITY", city })
          }
          onNewVenueState={(state: string) =>
            dispatch({ type: "SET_NEW_VENUE_STATE", state })
          }
          onSkipVenue={() => {
            dispatch({ type: "SET_SELECTED_VENUE_ID", id: "" });
            dispatch({ type: "SET_NEW_VENUE_NAME", name: "" });
          }}
          onBack={() => dispatch({ type: "SET_STEP", step: "review" })}
          onContinue={goToPromoter}
        />
      )}

      {state.step === "promoter" && (
        <PromoterStep
          promoters={state.promoters}
          selectedPromoterId={state.selectedPromoterId}
          eventsCount={state.eventsToImport.length}
          onSelectPromoter={(id) =>
            dispatch({ type: "SET_SELECTED_PROMOTER_ID", id })
          }
          onBack={goBackFromPromoter}
          onContinue={goToPreview}
        />
      )}

      {state.step === "preview" && (
        <PreviewStep
          eventsToImport={state.eventsToImport}
          extractedData={state.extractedData}
          venueOption={state.venueOption}
          venues={state.venues}
          datesConfirmed={state.datesConfirmed}
          url={state.url}
          onBack={() => dispatch({ type: "SET_STEP", step: "promoter" })}
          onSave={handleSave}
        />
      )}

      {state.step === "saving" && (
        <SavingStep
          eventsCount={state.eventsToImport.length}
          progress={state.savingProgress}
        />
      )}

      {state.step === "success" && (
        <SuccessStep
          createdEvents={state.createdEvents}
          batchErrors={state.batchErrors}
          onRetryFailed={state.batchErrors.length > 0 ? retryFailed : undefined}
          onReset={resetWizard}
        />
      )}
    </div>
  );
}
