import {
  AUSTIN_SERVICE_AREA,
  jsonError,
  pointInServiceArea,
  providerEndpoint,
  requestAllowed,
  sharedGeocoderRateLimitKey,
} from "./api-utils.js";

export const GEOCODE_CACHE_VERSION = "austin-geocode-v1";
export const GEOCODE_CACHE_TTL_SECONDS = 86_400;
export const GEOCODE_MAX_RESULTS = 5;
export const GEOCODE_MAX_QUERY_LENGTH = 120;
function geocoderProviderAccessHeaders(accessClientId, accessClientSecret) {
  if (!accessClientId && !accessClientSecret) return {};
  if (!accessClientId || !accessClientSecret) return null;
  return {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  };
}

function normalizedQuery(value) {
  const query = String(value ?? "").trim().replace(/\s+/g, " ");
  if (query.length < 2) throw new Error("Search query must contain at least two characters.");
  if (query.length > GEOCODE_MAX_QUERY_LENGTH) {
    throw new Error(`Search query must not exceed ${GEOCODE_MAX_QUERY_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(query)) {
    throw new Error("Search query contains unsupported control characters.");
  }
  return query;
}

function normalizedLimit(value) {
  if (value === null) return GEOCODE_MAX_RESULTS;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > GEOCODE_MAX_RESULTS) {
    throw new Error(`Limit must be an integer from 1 to ${GEOCODE_MAX_RESULTS}.`);
  }
  return limit;
}

async function geocodeCacheKey(requestUrl, query, limit) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(query.toLocaleLowerCase("en-US")),
  );
  const queryHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const url = new URL("/__edge-cache/geocode", requestUrl);
  url.searchParams.set("dataset", GEOCODE_CACHE_VERSION);
  url.searchParams.set("query", queryHash);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function providerSearchUrl(providerUrl, query, limit) {
  const url = providerEndpoint(providerUrl, "/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set(
    "viewbox",
    [
      AUSTIN_SERVICE_AREA.west,
      AUSTIN_SERVICE_AREA.north,
      AUSTIN_SERVICE_AREA.east,
      AUSTIN_SERVICE_AREA.south,
    ].join(","),
  );
  url.searchParams.set("bounded", "1");
  return url;
}

function normalizeBounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [south, north, west, east] = value.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function normalizeResults(value, limit) {
  if (!Array.isArray(value)) throw new Error("Geocoder returned an invalid result list.");
  return value
    .map((result) => {
      const point = {
        latitude: Number(result.lat ?? result.latitude),
        longitude: Number(result.lon ?? result.longitude),
      };
      const label = String(result.display_name ?? result.label ?? "").trim();
      if (!label || !pointInServiceArea(point)) return null;
      return {
        id: String(result.place_id ?? result.id ?? `${point.latitude},${point.longitude}`),
        label,
        ...point,
        bounds: normalizeBounds(result.boundingbox ?? result.bounds),
        category: String(result.category ?? result.class ?? "place"),
        type: String(result.addresstype ?? result.type ?? "place"),
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function withHeaders(response, headers) {
  const combined = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) combined.set(name, value);
  return new Response(response.body, { status: response.status, headers: combined });
}

export function createGeocodeHandler({
  providerUrl,
  accessClientId,
  accessClientSecret,
  cache,
  rateLimiter,
  fetchImpl = fetch,
} = {}) {
  const providerAccessHeaders = geocoderProviderAccessHeaders(accessClientId, accessClientSecret);
  return async function handleGeocode(request) {
    if (request.method !== "GET") return jsonError("Method not allowed.", 405);

    let query;
    let limit;
    try {
      const url = new URL(request.url);
      query = normalizedQuery(url.searchParams.get("q"));
      limit = normalizedLimit(url.searchParams.get("limit"));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Invalid geocoding request.", 400);
    }

    if (!providerUrl) return jsonError("Geocoding provider is not configured.", 503);
    if (!providerAccessHeaders) {
      return jsonError("Geocoding provider access is not configured.", 503);
    }
    const cacheRequest = new Request(
      await geocodeCacheKey(request.url, query, limit),
    );
    const cached = cache ? await cache.match(cacheRequest) : undefined;
    if (cached) return withHeaders(cached, { "X-Cache-Status": "HIT" });
    if (!(await requestAllowed(
      rateLimiter,
      request,
      sharedGeocoderRateLimitKey(providerUrl),
    ))) {
      return jsonError("Too many geocoding requests. Try again shortly.", 429);
    }

    try {
      const response = await fetchImpl(providerSearchUrl(providerUrl, query, limit), {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Austin-Hike-Bike-Atlas/1.0 (+https://github.com/ryanshores/Austin-Hike-and-Bike-Trails)",
          ...providerAccessHeaders,
        },
        redirect: "manual",
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
      const results = normalizeResults(await response.json(), limit);
      const normalized = Response.json(
        {
          results,
          attribution: "Search data © OpenStreetMap contributors",
          datasetVersion: GEOCODE_CACHE_VERSION,
        },
        {
          headers: {
            "Cache-Control": `public, max-age=${GEOCODE_CACHE_TTL_SECONDS}`,
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
      if (cache) {
        try {
          await cache.put(cacheRequest, normalized.clone());
        } catch {
          // A cache failure must not hide a valid provider response.
        }
      }
      return withHeaders(normalized, { "X-Cache-Status": "MISS" });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : "provider request failed";
      return jsonError(`Geocoding service unavailable: ${detail}.`, 502);
    }
  };
}
