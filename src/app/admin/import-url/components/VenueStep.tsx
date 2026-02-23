import { MapPin, ChevronRight, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ExtractedEventData } from "@/lib/url-import/types";
import type { Venue } from "../use-import-wizard";

interface VenueStepProps {
  extractedData: ExtractedEventData;
  venues: Venue[];
  similarVenues: Venue[];
  selectedVenueId: string;
  newVenueName: string;
  newVenueAddress: string;
  newVenueCity: string;
  newVenueState: string;
  onSelectVenue: (id: string) => void;
  onNewVenueName: (name: string) => void;
  onNewVenueAddress: (address: string) => void;
  onNewVenueCity: (city: string) => void;
  onNewVenueState: (state: string) => void;
  onSkipVenue: () => void;
  onBack: () => void;
  onContinue: () => void;
}

export function VenueStep({
  extractedData,
  venues,
  similarVenues,
  selectedVenueId,
  newVenueName,
  newVenueAddress,
  newVenueCity,
  newVenueState,
  onSelectVenue,
  onNewVenueName,
  onNewVenueAddress,
  onNewVenueCity,
  onNewVenueState,
  onSkipVenue,
  onBack,
  onContinue,
}: VenueStepProps) {
  return (
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
        {similarVenues.length > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">
              Matching Existing Venues:
            </p>
            <div className="space-y-2">
              {similarVenues.map((venue) => (
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
                    onChange={() => onSelectVenue(venue.id)}
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
            onChange={(e) => onSelectVenue(e.target.value)}
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
                onChange={(e) => onNewVenueName(e.target.value)}
                placeholder="Enter venue name"
                className="mt-1"
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="newVenueAddress">Address</Label>
              <Input
                id="newVenueAddress"
                value={newVenueAddress}
                onChange={(e) => onNewVenueAddress(e.target.value)}
                placeholder="Street address"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="newVenueCity">City</Label>
              <Input
                id="newVenueCity"
                value={newVenueCity}
                onChange={(e) => onNewVenueCity(e.target.value)}
                placeholder="City"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="newVenueState">State</Label>
              <Input
                id="newVenueState"
                value={newVenueState}
                onChange={(e) => onNewVenueState(e.target.value)}
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
              if (e.target.checked) onSkipVenue();
            }}
            className="rounded border-gray-300"
          />
          Skip venue (create event without venue)
        </label>

        {/* Navigation */}
        <div className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <Button onClick={onContinue}>
            Continue to Promoter
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
