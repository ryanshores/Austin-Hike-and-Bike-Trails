import {
  haversineMiles,
  jsonError,
  pointInServiceArea,
  providerEndpoint,
  readJsonBody,
  requestAllowed,
} from "./api-utils.js";
import {
  SafetyPreference,
  classifyRouteEdge,
  rankRouteCandidates,
  summarizeRoute,
} from "./route-safety.js";

export const ROUTE_DATASET_VERSION = "austin-route-safety-v1";
export const ROUTE_MAX_BODY_BYTES = 65_536;
export const ROUTE_MAX_DIRECT_DISTANCE_MILES = 75;

const PREFERENCES = new Set(Object.values(SafetyPreference));

function normalizedPoint(value, label) {
  const point = {
    latitude: Number(value?.latitude),
    longitude: Number(value?.longitude),
  };
  if (!pointInServiceArea(point)) {
    throw new Error(`${label} must be a coordinate inside the Austin service area.`);
  }
  return point;
}

function validatedRouteRequest(value) {
  const start = normalizedPoint(value?.start, "Start");
  const destination = normalizedPoint(value?.destination, "Destination");
  if (!PREFERENCES.has(value?.safetyPreference)) {
    throw new Error("Safety preference is not supported.");
  }
  if (haversineMiles(start, destination) > ROUTE_MAX_DIRECT_DISTANCE_MILES) {
    throw new Error(
      `Start and destination must be within ${ROUTE_MAX_DIRECT_DISTANCE_MILES} miles.`,
    );
  }
  return { start, destination, safetyPreference: value.safetyPreference };
}

export function decodePolyline6(encoded) {
  const coordinates = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    const deltas = [];
    for (let coordinateIndex = 0; coordinateIndex < 2; coordinateIndex += 1) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        if (index >= encoded.length) throw new Error("Routing provider returned invalid geometry.");
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    latitude += deltas[0];
    longitude += deltas[1];
    coordinates.push([longitude / 1e6, latitude / 1e6]);
  }
  if (coordinates.length < 2) throw new Error("Routing provider returned empty geometry.");
  return coordinates;
}

function mergedLegGeometry(legs) {
  const coordinates = [];
  for (const leg of legs ?? []) {
    const legCoordinates = decodePolyline6(String(leg.shape ?? ""));
    for (const coordinate of legCoordinates) {
      const previous = coordinates.at(-1);
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
        coordinates.push(coordinate);
      }
    }
  }
  if (coordinates.length < 2) throw new Error("Routing provider returned empty geometry.");
  return { type: "LineString", coordinates };
}

function candidateGeometry(candidate) {
  if (
    candidate.geometry?.type === "LineString" &&
    Array.isArray(candidate.geometry.coordinates) &&
    candidate.geometry.coordinates.length >= 2
  ) {
    return candidate.geometry;
  }
  if (typeof candidate.shape === "string") {
    return { type: "LineString", coordinates: decodePolyline6(candidate.shape) };
  }
  return mergedLegGeometry(candidate.legs);
}

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizedManeuvers(candidate) {
  return (candidate.maneuvers ?? candidate.legs?.flatMap((leg) => leg.maneuvers ?? []) ?? [])
    .map((maneuver) => ({
      type: Number.isFinite(Number(maneuver.type)) ? Number(maneuver.type) : null,
      instruction: String(maneuver.instruction ?? maneuver.verbal_pre_transition_instruction ?? "").trim(),
      distanceMiles: finiteNonNegative(maneuver.length ?? maneuver.distanceMiles),
      beginShapeIndex: Number.isInteger(maneuver.begin_shape_index)
        ? maneuver.begin_shape_index
        : Number.isInteger(maneuver.beginShapeIndex)
          ? maneuver.beginShapeIndex
          : null,
      endShapeIndex: Number.isInteger(maneuver.end_shape_index)
        ? maneuver.end_shape_index
        : Number.isInteger(maneuver.endShapeIndex)
          ? maneuver.endShapeIndex
          : null,
      streetNames: Array.isArray(maneuver.street_names ?? maneuver.streetNames)
        ? (maneuver.street_names ?? maneuver.streetNames).map(String)
        : [],
    }))
    .filter((maneuver) => maneuver.instruction);
}

function elevationTotals(rangeHeight) {
  if (!Array.isArray(rangeHeight)) throw new Error("Elevation provider returned an invalid profile.");
  let ascentMeters = 0;
  let descentMeters = 0;
  let previous = null;
  for (const sample of rangeHeight) {
    const height = Number(sample?.[1]);
    if (!Number.isFinite(height)) continue;
    if (previous !== null) {
      const delta = height - previous;
      if (delta > 0) ascentMeters += delta;
      else descentMeters += Math.abs(delta);
    }
    previous = height;
  }
  if (previous === null) throw new Error("Elevation provider returned no usable heights.");
  return {
    totalAscentFeet: ascentMeters * 3.28084,
    totalDescentFeet: descentMeters * 3.28084,
  };
}

async function fetchElevation(candidate, providerUrl, fetchImpl, signal) {
  if (
    Number.isFinite(Number(candidate.totalAscentFeet)) &&
    Number.isFinite(Number(candidate.totalDescentFeet))
  ) {
    return {
      totalAscentFeet: finiteNonNegative(candidate.totalAscentFeet),
      totalDescentFeet: finiteNonNegative(candidate.totalDescentFeet),
    };
  }
  const encodedPolyline =
    typeof candidate.shape === "string"
      ? candidate.shape
      : candidate.legs?.length === 1 && typeof candidate.legs[0].shape === "string"
        ? candidate.legs[0].shape
        : null;
  const body = encodedPolyline
    ? { encoded_polyline: encodedPolyline, shape_format: "polyline6" }
    : {
        shape: candidateGeometry(candidate).coordinates.map(([longitude, latitude]) => ({
          lat: latitude,
          lon: longitude,
        })),
      };
  const response = await fetchImpl(providerEndpoint(providerUrl, "/height"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      ...body,
      range: true,
      resample_distance: 30,
      height_precision: 1,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`elevation provider returned HTTP ${response.status}`);
  return elevationTotals((await response.json()).range_height);
}

function providerCandidates(value) {
  if (Array.isArray(value?.candidates)) return value.candidates;
  if (value?.trip) return [value.trip];
  throw new Error("Routing provider returned no route candidates.");
}

function totalMilesFor(candidate) {
  return finiteNonNegative(
    candidate.totalMiles ??
      candidate.summary?.length ??
      candidate.legs?.reduce((sum, leg) => sum + finiteNonNegative(leg.summary?.length), 0),
  );
}

function normalizedEdges(candidate, geometry, elevation) {
  const providerEdges = Array.isArray(candidate.edges) ? candidate.edges : [];
  if (providerEdges.length === 0) {
    const classification = classifyRouteEdge();
    return [{
      ...classification,
      miles: totalMilesFor(candidate),
      ascentFeet: elevation.totalAscentFeet,
      descentFeet: elevation.totalDescentFeet,
      geometry,
    }];
  }
  return providerEdges.map((edge) => ({
    ...edge,
    ...classifyRouteEdge({
      city: edge.city,
      osm: edge.osm,
      source: edge.source,
      travelDirection: edge.travelDirection,
    }),
    miles: finiteNonNegative(edge.miles),
    ascentFeet: finiteNonNegative(edge.ascentFeet),
    descentFeet: finiteNonNegative(edge.descentFeet),
  }));
}

async function normalizeCandidate(candidate, preference, providerUrl, fetchImpl, signal) {
  const geometry = candidateGeometry(candidate);
  const elevation = await fetchElevation(candidate, providerUrl, fetchImpl, signal);
  const edges = normalizedEdges(candidate, geometry, elevation);
  return {
    geometry,
    edges,
    maneuvers: normalizedManeuvers(candidate),
    trafficExposureCost: finiteNonNegative(
      candidate.trafficExposureCost,
      Number.MAX_SAFE_INTEGER,
    ),
    summary: summarizeRoute(edges, preference),
  };
}

function publicRoute(candidate, versions) {
  const { summary } = candidate;
  return {
    geometry: candidate.geometry,
    totalMiles: summary.totalMiles,
    totalAscentFeet: summary.totalAscentFeet,
    totalDescentFeet: summary.totalDescentFeet,
    mileageBySafetyClass: summary.mileageBySafetyClass,
    divergenceCount: summary.divergenceCount,
    divergenceMiles: summary.divergenceMiles,
    divergences: summary.divergences,
    maneuvers: candidate.maneuvers,
    versions,
  };
}

async function routingGraphVersion(providerValue, providerUrl, fetchImpl, signal) {
  const embedded =
    providerValue.routingGraphVersion ??
    providerValue.trip?.routingGraphVersion;
  if (embedded !== undefined && embedded !== null && String(embedded).trim()) {
    return String(embedded);
  }
  const response = await fetchImpl(providerEndpoint(providerUrl, "/status"), {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`routing status provider returned HTTP ${response.status}`);
  }
  const status = await response.json();
  const version = status.osm_changeset ?? status.tileset_last_modified;
  if (version === undefined || version === null || !String(version).trim()) {
    throw new Error("Routing provider did not report a graph version.");
  }
  return String(version);
}

export function createRoutesHandler({
  providerUrl,
  rateLimiter,
  fetchImpl = fetch,
} = {}) {
  return async function handleRoutes(request) {
    if (request.method !== "POST") return jsonError("Method not allowed.", 405);
    if (!(await requestAllowed(rateLimiter, request))) {
      return jsonError("Too many route requests. Try again shortly.", 429);
    }

    let routeRequest;
    try {
      routeRequest = validatedRouteRequest(
        await readJsonBody(request, ROUTE_MAX_BODY_BYTES),
      );
    } catch (error) {
      const status = error instanceof RangeError ? 413 : 400;
      return jsonError(error instanceof Error ? error.message : "Invalid route request.", status);
    }
    if (!providerUrl) return jsonError("Routing provider is not configured.", 503);

    try {
      const response = await fetchImpl(providerEndpoint(providerUrl, "/route"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          locations: [
            { lat: routeRequest.start.latitude, lon: routeRequest.start.longitude, type: "break" },
            {
              lat: routeRequest.destination.latitude,
              lon: routeRequest.destination.longitude,
              type: "break",
            },
          ],
          costing: "bicycle",
          units: "miles",
          alternates: 2,
          shape_format: "polyline6",
          directions_options: { units: "miles" },
        }),
        signal: request.signal,
      });
      if (!response.ok) {
        const status = response.status === 400 || response.status === 404 ? 422 : 502;
        return jsonError(
          status === 422
            ? "No reasonable bicycle route was found for those endpoints."
            : `Routing service unavailable: provider returned HTTP ${response.status}.`,
          status,
          status === 422 ? { code: "no-reasonable-route" } : {},
        );
      }
      const providerValue = await response.json();
      const [candidates, graphVersion] = await Promise.all([
        Promise.all(providerCandidates(providerValue).map((candidate) =>
          normalizeCandidate(
            candidate,
            routeRequest.safetyPreference,
            providerUrl,
            fetchImpl,
            request.signal,
          ),
        )),
        routingGraphVersion(
          providerValue,
          providerUrl,
          fetchImpl,
          request.signal,
        ),
      ]);
      const ranked = rankRouteCandidates(candidates, routeRequest.safetyPreference);
      const selected = ranked.find(
        (candidate) => !candidate.summary.hasBicycleProhibitedEdge,
      );
      if (!selected) {
        return jsonError(
          "No reasonable bicycle route was found for the selected safety preference.",
          422,
          { code: "no-reasonable-route" },
        );
      }
      return Response.json(
        {
          safetyPreference: routeRequest.safetyPreference,
          route: publicRoute(selected, {
            dataset: providerValue.datasetVersion ?? ROUTE_DATASET_VERSION,
            routingGraph: graphVersion,
          }),
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : "provider request failed";
      return jsonError(`Routing service unavailable: ${detail}.`, 502);
    }
  };
}

export function createRoutingHealthHandler({ providerUrl, fetchImpl = fetch } = {}) {
  return async function handleRoutingHealth(request) {
    if (request.method !== "GET") return jsonError("Method not allowed.", 405);
    if (!providerUrl) {
      return jsonError("Routing provider is not configured.", 503, {
        status: "unavailable",
      });
    }
    try {
      const response = await fetchImpl(providerEndpoint(providerUrl, "/status"), {
        headers: { Accept: "application/json" },
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
      const status = await response.json();
      return Response.json(
        {
          status: status.has_tiles === false ? "degraded" : "ok",
          provider: "valhalla",
          version: String(status.version ?? "unknown"),
          routingGraphVersion: String(
            status.osm_changeset ?? status.tileset_last_modified ?? "unknown",
          ),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : "provider request failed";
      return jsonError(`Routing provider health check failed: ${detail}.`, 502, {
        status: "unavailable",
      });
    }
  };
}
