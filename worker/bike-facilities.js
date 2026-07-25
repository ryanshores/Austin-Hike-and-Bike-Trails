const ARCGIS_ENDPOINT =
  "https://maps.austintexas.gov/arcgis/rest/services/AmandaROW/Reference_1/MapServer/0/query";

export const BIKE_CACHE_DATASET_VERSION = "austin-bike-facilities-v1";
export const BIKE_CACHE_TTL_SECONDS = 300;
export const BIKE_BOUNDS_BUCKET_DEGREES = 0.01;
export const BIKE_PAGE_SIZE = 2000;
export const BIKE_MAX_FEATURES = 20000;

const QUERY_FIELDS =
  "OBJECTID,FULL_STREET_NAME,LINE_TYPE,BICYCLE_FACILITY,BIKE_LEVEL_OF_COMFORT";

function roundedCoordinate(value) {
  return Number(value.toFixed(6));
}

export function parseBounds(value) {
  if (!value) throw new Error("The bounds query parameter is required.");
  const coordinates = value.split(",").map(Number);
  if (coordinates.length !== 4 || coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error("Bounds must contain four finite coordinates.");
  }

  const [west, south, east, north] = coordinates;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new Error("Bounds are outside the supported coordinate range.");
  }
  if (east - west > 5 || north - south > 5) {
    throw new Error("Bounds must describe a viewport no larger than five degrees.");
  }
  return { west, south, east, north };
}

export function quantizeBounds(bounds, bucketSize = BIKE_BOUNDS_BUCKET_DEGREES) {
  return {
    west: roundedCoordinate(Math.floor(bounds.west / bucketSize) * bucketSize),
    south: roundedCoordinate(Math.floor(bounds.south / bucketSize) * bucketSize),
    east: roundedCoordinate(Math.ceil(bounds.east / bucketSize) * bucketSize),
    north: roundedCoordinate(Math.ceil(bounds.north / bucketSize) * bucketSize),
  };
}

export function boundsKey(bounds) {
  return [bounds.west, bounds.south, bounds.east, bounds.north]
    .map((coordinate) => coordinate.toFixed(6))
    .join(",");
}

export function bikeCacheKey(requestUrl, bounds) {
  const url = new URL("/__edge-cache/bike-facilities", requestUrl);
  url.searchParams.set("dataset", BIKE_CACHE_DATASET_VERSION);
  url.searchParams.set("bounds", boundsKey(bounds));
  return url.toString();
}

function upstreamUrl(bounds, offset) {
  const parameters = new URLSearchParams({
    where: "BICYCLE_FACILITY IS NOT NULL",
    outFields: QUERY_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    geometry: boundsKey(bounds),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    orderByFields: "OBJECTID",
    resultOffset: String(offset),
    resultRecordCount: String(BIKE_PAGE_SIZE),
    f: "geojson",
  });
  return `${ARCGIS_ENDPOINT}?${parameters}`;
}

function validatedPage(value) {
  if (!value || typeof value !== "object" || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error("ArcGIS returned an invalid GeoJSON feature collection.");
  }
  return value;
}

export async function fetchAllBikeFacilities(bounds, fetchImpl, signal) {
  const features = [];

  for (let offset = 0; offset < BIKE_MAX_FEATURES; offset += BIKE_PAGE_SIZE) {
    const response = await fetchImpl(upstreamUrl(bounds, offset), { signal });
    if (!response.ok) throw new Error(`ArcGIS returned HTTP ${response.status}.`);
    const page = validatedPage(await response.json());
    features.push(...page.features);

    const exceededTransferLimit =
      page.exceededTransferLimit === true || page.properties?.exceededTransferLimit === true;
    if (!exceededTransferLimit || page.features.length < BIKE_PAGE_SIZE) {
      return { type: "FeatureCollection", features };
    }
  }

  throw new Error(`ArcGIS exceeded the ${BIKE_MAX_FEATURES.toLocaleString()} feature safety limit.`);
}

function responseWithHeaders(response, headers) {
  const combinedHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) combinedHeaders.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: combinedHeaders,
  });
}

function jsonError(message, status, startedAt, now) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Server-Timing": `total;dur=${Math.max(0, now() - startedAt).toFixed(1)}`,
        "X-Cache-Status": "BYPASS",
      },
    },
  );
}

export function createBikeFacilitiesHandler({
  cache,
  fetchImpl = fetch,
  now = () => performance.now(),
} = {}) {
  return async function handleBikeFacilities(request) {
    const startedAt = now();
    if (request.method !== "GET") {
      return jsonError("Method not allowed.", 405, startedAt, now);
    }

    let quantizedBounds;
    try {
      const url = new URL(request.url);
      quantizedBounds = quantizeBounds(parseBounds(url.searchParams.get("bounds")));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid bounds.";
      return jsonError(message, 400, startedAt, now);
    }

    const cacheRequest = new Request(bikeCacheKey(request.url, quantizedBounds));
    const cached = cache ? await cache.match(cacheRequest) : undefined;
    if (cached) {
      return responseWithHeaders(cached, {
        "Server-Timing": `cache;desc="HIT", total;dur=${Math.max(0, now() - startedAt).toFixed(1)}`,
        "X-Cache-Status": "HIT",
      });
    }

    const upstreamStartedAt = now();
    try {
      const collection = await fetchAllBikeFacilities(quantizedBounds, fetchImpl, request.signal);
      const upstreamDuration = Math.max(0, now() - upstreamStartedAt);
      const cacheable = Response.json(collection, {
        headers: {
          "Cache-Control": `public, max-age=${BIKE_CACHE_TTL_SECONDS}`,
          "Content-Type": "application/geo+json; charset=utf-8",
          "X-Dataset-Version": BIKE_CACHE_DATASET_VERSION,
        },
      });
      if (cache) {
        try {
          await cache.put(cacheRequest, cacheable.clone());
        } catch {
          // A cache write failure must not hide a valid live ArcGIS response.
        }
      }
      return responseWithHeaders(cacheable, {
        "Server-Timing": `cache;desc="MISS", arcgis;dur=${upstreamDuration.toFixed(1)}, total;dur=${Math.max(0, now() - startedAt).toFixed(1)}`,
        "X-Cache-Status": "MISS",
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : "ArcGIS request failed.";
      return jsonError(`Bicycle facility service unavailable: ${message}`, 502, startedAt, now);
    }
  };
}
