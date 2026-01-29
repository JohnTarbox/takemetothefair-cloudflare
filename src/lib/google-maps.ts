// Google Maps Geocoding and Places API (server-side fetch, edge-compatible)

interface GeocodeResult {
  lat: number;
  lng: number;
  zip: string | null;
  placeId: string;
}

interface PlaceLookupResult {
  phone: string | null;
  website: string | null;
  lat: number | null;
  lng: number | null;
  zip: string | null;
  formattedAddress: string | null;
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
    addressComponents?: Array<{
      longText: string;
      shortText: string;
      types: string[];
    }>;
  }>;
}

function getApiKey(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

export async function geocodeAddress(
  address: string,
  city: string,
  state: string,
  zip?: string
): Promise<GeocodeResult | null> {
  const apiKey = getApiKey();
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
  state: string
): Promise<PlaceLookupResult | null> {
  const apiKey = getApiKey();
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
          "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.websiteUri,places.addressComponents",
      },
      body: JSON.stringify({ textQuery }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as PlacesSearchResponse;
    if (!data.places?.length) return null;

    const place = data.places[0];
    const zipComponent = place.addressComponents?.find((c) =>
      c.types.includes("postal_code")
    );

    return {
      phone: place.nationalPhoneNumber || null,
      website: place.websiteUri || null,
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      zip: zipComponent?.shortText || null,
      formattedAddress: place.formattedAddress || null,
    };
  } catch {
    return null;
  }
}
