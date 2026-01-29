// Google Maps Geocoding and Places API (server-side fetch, edge-compatible)

interface GeocodeResult {
  lat: number;
  lng: number;
  zip: string | null;
  placeId: string;
}

interface PlaceLookupResult {
  name: string | null;
  phone: string | null;
  website: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  formattedAddress: string | null;
  photoUrl: string | null;
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  openingHours: string | null;
  googleRating: number | null;
  googleRatingCount: number | null;
  googleTypes: string | null;
  accessibility: string | null;
  parking: string | null;
  description: string | null;
  businessStatus: string | null;
  outdoorSeating: boolean | null;
}

interface GeocodingResponse {
  status: string;
  results: Array<{
    geometry: { location: { lat: number; lng: number } };
    place_id: string;
    address_components: Array<{
      long_name: string;
      short_name: string;
      types: string[];
    }>;
  }>;
}

interface PlacesSearchResponse {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    nationalPhoneNumber?: string;
    websiteUri?: string;
    googleMapsUri?: string;
    photos?: Array<{ name: string }>;
    addressComponents?: Array<{
      longText: string;
      shortText: string;
      types: string[];
    }>;
    regularOpeningHours?: unknown;
    rating?: number;
    userRatingCount?: number;
    types?: string[];
    accessibilityOptions?: unknown;
    parkingOptions?: unknown;
    editorialSummary?: { text: string };
    businessStatus?: string;
    outdoorSeating?: boolean;
  }>;
}

export async function geocodeAddress(
  address: string,
  city: string,
  state: string,
  zip?: string,
  apiKey?: string | null
): Promise<GeocodeResult | null> {
  if (!apiKey) return null;

  const parts = [address, city, state, zip].filter(Boolean).join(", ");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(parts)}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = (await res.json()) as GeocodingResponse;
    if (data.status !== "OK" || !data.results.length) return null;

    const result = data.results[0];
    const zipComponent = result.address_components.find((c) =>
      c.types.includes("postal_code")
    );

    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      zip: zipComponent?.short_name || null,
      placeId: result.place_id,
    };
  } catch {
    return null;
  }
}

export async function lookupPlace(
  name: string,
  city: string,
  state: string,
  apiKey?: string | null
): Promise<PlaceLookupResult | null> {
  if (!apiKey) return null;

  const textQuery = `${name} ${city} ${state}`;
  const url = "https://places.googleapis.com/v1/places:searchText";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.addressComponents,places.photos,places.regularOpeningHours,places.rating,places.userRatingCount,places.types,places.accessibilityOptions,places.parkingOptions,places.editorialSummary,places.businessStatus,places.outdoorSeating",
      },
      body: JSON.stringify({ textQuery }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as PlacesSearchResponse;
    if (!data.places?.length) return null;

    const place = data.places[0];
    const getComponent = (type: string) =>
      place.addressComponents?.find((c) => c.types.includes(type));
    const streetNumber = getComponent("street_number")?.longText || "";
    const route = getComponent("route")?.longText || "";
    const streetAddress = [streetNumber, route].filter(Boolean).join(" ") || null;
    const cityComponent = getComponent("locality")?.longText || null;
    const stateComponent = getComponent("administrative_area_level_1")?.shortText || null;
    const zipComponent = getComponent("postal_code");

    // Fetch photo URL if available
    let photoUrl: string | null = null;
    if (place.photos?.length) {
      try {
        const photoName = place.photos[0].name;
        const photoRes = await fetch(
          `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${apiKey}&skipHttpRedirect=true`
        );
        if (photoRes.ok) {
          const photoData = (await photoRes.json()) as { photoUri?: string };
          photoUrl = photoData.photoUri || null;
        }
      } catch {
        // Photo fetch failed, continue without it
      }
    }

    return {
      name: place.displayName?.text || null,
      phone: place.nationalPhoneNumber || null,
      website: place.websiteUri || null,
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      address: streetAddress,
      city: cityComponent,
      state: stateComponent,
      zip: zipComponent?.shortText || null,
      formattedAddress: place.formattedAddress || null,
      photoUrl,
      googlePlaceId: place.id || null,
      googleMapsUrl: place.googleMapsUri || null,
      openingHours: place.regularOpeningHours ? JSON.stringify(place.regularOpeningHours) : null,
      googleRating: place.rating ?? null,
      googleRatingCount: place.userRatingCount ?? null,
      googleTypes: place.types ? JSON.stringify(place.types) : null,
      accessibility: place.accessibilityOptions ? JSON.stringify(place.accessibilityOptions) : null,
      parking: place.parkingOptions ? JSON.stringify(place.parkingOptions) : null,
      description: place.editorialSummary?.text || null,
      businessStatus: place.businessStatus || null,
      outdoorSeating: place.outdoorSeating ?? null,
    };
  } catch {
    return null;
  }
}
