import {
  haversineMiles,
  jsonError,
  pointInServiceArea,
  providerEndpoint,
  readJsonBody,
  requestAllowed,
} from "./api-utils.js";
import {
  SafetyClass,
  SafetyFinding,
  SafetyPreference,
  classifyRouteEdge,
  rankRouteCandidates,
  summarizeRoute,
} from "./route-safety.js";

const BICYCLE_USE_ROADS = Object.freeze({
  [SafetyPreference.ANY_BICYCLE_LEGAL]: 0.5,
  [SafetyPreference.BIKE_FACILITY_OR_SAFER]: 0.25,
  [SafetyPreference.PROTECTED_OR_SEPARATED]: 0.1,
  [SafetyPreference.FULLY_SEPARATED]: 0,
});

export const ROUTE_DATASET_VERSION = "austin-route-safety-v1";
export const ROUTE_MAX_BODY_BYTES = 65_536;
export const ROUTE_MAX_DIRECT_DISTANCE_MILES = 75;
export const ROUTE_METRIC_EVENT = "route_request";

const PREFERENCES = new Set(Object.values(SafetyPreference));
const SAFETY_CLASSES = new Set(Object.values(SafetyClass));
const SAFETY_FINDINGS = new Set(Object.values(SafetyFinding));
const CLASSIFICATION_SOURCES = new Set(["city", "osm", "city-osm", "atlas-trail"]);

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
    const coordinates = candidate.geometry.coordinates.map((coordinate) => {
      if (
        !Array.isArray(coordinate) ||
        coordinate.length < 2 ||
        !Number.isFinite(coordinate[0]) ||
        !Number.isFinite(coordinate[1])
      ) {
        throw new Error("Routing provider returned invalid geometry coordinates.");
      }
      return [coordinate[0], coordinate[1]];
    });
    return { type: "LineString", coordinates };
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

function routingProviderAccessHeaders(accessClientId, accessClientSecret) {
  if (!accessClientId && !accessClientSecret) return {};
  if (!accessClientId || !accessClientSecret) return null;
  return {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  };
}

function providerRequestHeaders(providerAccessHeaders, headers) {
  return { ...headers, ...providerAccessHeaders };
}

async function fetchElevation(candidate, providerUrl, providerAccessHeaders, fetchImpl, signal) {
  const totalAscentFeet = explicitElevation(candidate.totalAscentFeet);
  const totalDescentFeet = explicitElevation(candidate.totalDescentFeet);
  if (totalAscentFeet !== null && totalDescentFeet !== null) {
    return {
      totalAscentFeet,
      totalDescentFeet,
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
    redirect: "manual",
    headers: providerRequestHeaders(providerAccessHeaders, {
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
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
  if (value?.trip) {
    const alternates = Array.isArray(value.alternates)
      ? value.alternates.map((alternate) => alternate?.trip).filter(Boolean)
      : [];
    return [value.trip, ...alternates];
  }
  throw new Error("Routing provider returned no route candidates.");
}

function totalMilesFor(candidate) {
  return finiteNonNegative(
    candidate.totalMiles ??
      candidate.summary?.length ??
      candidate.legs?.reduce((sum, leg) => sum + finiteNonNegative(leg.summary?.length), 0),
  );
}

function explicitElevation(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function reportRouteOutcome(reportMetric, now, startedAt, response, outcome, safetyPreference) {
  if (!reportMetric) return;
  const elapsedMs = Number(now()) - startedAt;
  const metric = {
    event: ROUTE_METRIC_EVENT,
    outcome,
    status: response.status,
    durationMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
  };
  if (safetyPreference) metric.safetyPreference = safetyPreference;
  try {
    reportMetric(metric);
  } catch {
    // Metrics must not change routing availability.
  }
}

function distributeRouteElevation(edges, property, total) {
  const missing = edges.filter((edge) => explicitElevation(edge[property]) === null);
  if (missing.length === 0) {
    return edges.map((edge) => ({ ...edge, [property]: explicitElevation(edge[property]) }));
  }

  const supplied = edges.reduce(
    (sum, edge) => sum + (explicitElevation(edge[property]) ?? 0),
    0,
  );
  const remaining = Math.max(0, total - supplied);
  const totalMissingMiles = missing.reduce((sum, edge) => sum + edge.miles, 0);
  let allocated = 0;
  let remainingCount = missing.length;

  return edges.map((edge) => {
    const existing = explicitElevation(edge[property]);
    if (existing !== null) return { ...edge, [property]: existing };
    remainingCount -= 1;
    const amount = remainingCount === 0
      ? remaining - allocated
      : totalMissingMiles > 0
        ? remaining * (edge.miles / totalMissingMiles)
        : remaining / missing.length;
    allocated += amount;
    return { ...edge, [property]: amount };
  });
}

function normalizedEdgeClassification(edge) {
  const osmClassification = classifyRouteEdge({
    osm: edge.osm,
    travelDirection: edge.travelDirection,
  });
  if (osmClassification.finding === SafetyFinding.BICYCLE_PROHIBITED) {
    return osmClassification;
  }

  if (edge.classification === undefined) {
    return classifyRouteEdge({
      city: edge.city,
      osm: edge.osm,
      source: edge.source,
      travelDirection: edge.travelDirection,
    });
  }

  const classification = edge.classification;
  const reason = typeof classification?.reason === "string"
    ? classification.reason.trim()
    : "";
  const prohibited = classification?.finding === SafetyFinding.BICYCLE_PROHIBITED;
  const validSafetyClass = classification?.safetyClass === null
    ? prohibited
    : SAFETY_CLASSES.has(classification?.safetyClass) && !prohibited;
  if (
    !classification ||
    Array.isArray(classification) ||
    !validSafetyClass ||
    !SAFETY_FINDINGS.has(classification.finding) ||
    !CLASSIFICATION_SOURCES.has(classification.source) ||
    !reason
  ) {
    throw new Error("Routing provider returned an invalid edge classification");
  }

  return {
    safetyClass: classification.safetyClass,
    finding: classification.finding,
    source: classification.source,
    reason,
  };
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
  const classified = providerEdges.map((edge) => ({
    ...edge,
    ...normalizedEdgeClassification(edge),
    miles: finiteNonNegative(edge.miles),
  }));
  return distributeRouteElevation(
    distributeRouteElevation(classified, "ascentFeet", elevation.totalAscentFeet),
    "descentFeet",
    elevation.totalDescentFeet,
  );
}

function unknownEdgeClassification() {
  return classifyRouteEdge();
}

function edgeGeometry(geometry, edge) {
  const begin = Number(edge?.begin_shape_index);
  const end = Number(edge?.end_shape_index);
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end < begin) {
    throw new Error("Routing provider returned invalid edge shape indexes.");
  }
  const coordinates = geometry.coordinates.slice(begin, end + 1);
  if (coordinates.length < 2) {
    throw new Error("Routing provider returned an edge without usable geometry.");
  }
  return { type: "LineString", coordinates };
}

async function attributedEdges(
  geometry,
  routingGraphVersion,
  providerUrl,
  providerAccessHeaders,
  enrichmentStore,
  fetchImpl,
  signal,
) {
  if (!enrichmentStore) return null;
  const response = await fetchImpl(providerEndpoint(providerUrl, "/trace_attributes"), {
    method: "POST",
    redirect: "manual",
    headers: providerRequestHeaders(providerAccessHeaders, {
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    body: JSON.stringify({
      shape: geometry.coordinates.map(([longitude, latitude]) => ({ lat: latitude, lon: longitude })),
      shape_match: "edge_walk",
      costing: "bicycle",
      costing_options: { bicycle: { bicycle_type: "hybrid" } },
      units: "miles",
      filters: {
        attributes: [
          "edge.id",
          "edge.length",
          "edge.begin_shape_index",
          "edge.end_shape_index",
        ],
        action: "include",
      },
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`route edge attribution provider returned HTTP ${response.status}`);
  }
  const attributed = (await response.json()).edges;
  if (!Array.isArray(attributed) || attributed.length === 0) {
    throw new Error("Routing provider returned no attributed route edges.");
  }
  const edgeIds = attributed.map((edge) => String(edge?.id ?? "").trim());
  if (edgeIds.some((edgeId) => !edgeId)) {
    throw new Error("Routing provider returned an attributed edge without a stable graph ID.");
  }
  const records = await enrichmentStore.lookup({ routingGraphVersion, edgeIds });
  return attributed.map((edge) => {
    const record = records.get(String(edge.id));
    let classification = unknownEdgeClassification();
    if (record) {
      try {
        classification = normalizedEdgeClassification(record);
      } catch {
        // A malformed sidecar row must not become a route outage or a safety
        // promotion. Treat this exact edge as unknown until the next import.
      }
    }
    return {
      ...(record ?? { osm: {}, city: null, travelDirection: null }),
      classification,
      miles: finiteNonNegative(edge.length),
      geometry: edgeGeometry(geometry, edge),
    };
  });
}

async function normalizeCandidate(
  candidate,
  preference,
  routingGraphVersionPromise,
  providerUrl,
  providerAccessHeaders,
  enrichmentStore,
  fetchImpl,
  signal,
) {
  const geometry = candidateGeometry(candidate);
  const elevationPromise = fetchElevation(
    candidate,
    providerUrl,
    providerAccessHeaders,
    fetchImpl,
    signal,
  );
  let enrichedCandidate = candidate;
  if (!Array.isArray(candidate.edges) && enrichmentStore) {
    try {
      const edges = await attributedEdges(
        geometry,
        await routingGraphVersionPromise,
        providerUrl,
        providerAccessHeaders,
        enrichmentStore,
        fetchImpl,
        signal,
      );
      if (edges) enrichedCandidate = { ...candidate, edges };
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const elevation = await elevationPromise;
  const edges = normalizedEdges(enrichedCandidate, geometry, elevation);
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

async function routingGraphVersion(
  providerValue,
  providerUrl,
  providerAccessHeaders,
  fetchImpl,
  signal,
) {
  const embedded =
    providerValue.routingGraphVersion ??
    providerValue.trip?.routingGraphVersion;
  if (embedded !== undefined && embedded !== null && String(embedded).trim()) {
    return String(embedded);
  }
  const response = await fetchImpl(providerEndpoint(providerUrl, "/status"), {
    redirect: "manual",
    headers: providerRequestHeaders(providerAccessHeaders, { Accept: "application/json" }),
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
  accessClientId,
  accessClientSecret,
  rateLimiter,
  enrichmentStore,
  reportMetric,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const providerAccessHeaders = routingProviderAccessHeaders(accessClientId, accessClientSecret);
  return async function handleRoutes(request) {
    const startedAt = Number(now());
    const respond = (response, outcome, safetyPreference) => {
      reportRouteOutcome(reportMetric, now, startedAt, response, outcome, safetyPreference);
      return response;
    };
    if (request.method !== "POST") return respond(jsonError("Method not allowed.", 405), "method-not-allowed");
    if (!(await requestAllowed(rateLimiter, request))) {
      return respond(jsonError("Too many route requests. Try again shortly.", 429), "rate-limited");
    }

    let routeRequest;
    try {
      routeRequest = validatedRouteRequest(
        await readJsonBody(request, ROUTE_MAX_BODY_BYTES),
      );
    } catch (error) {
      const status = error instanceof RangeError ? 413 : 400;
      return respond(
        jsonError(error instanceof Error ? error.message : "Invalid route request.", status),
        "invalid-request",
      );
    }
    if (!providerUrl) {
      return respond(
        jsonError("Routing provider is not configured.", 503),
        "provider-unconfigured",
        routeRequest.safetyPreference,
      );
    }
    if (!providerAccessHeaders) {
      return respond(
        jsonError("Routing provider access is not configured.", 503),
        "provider-access-unconfigured",
        routeRequest.safetyPreference,
      );
    }

    try {
      const response = await fetchImpl(providerEndpoint(providerUrl, "/route"), {
        method: "POST",
        redirect: "manual",
        headers: providerRequestHeaders(providerAccessHeaders, {
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
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
          costing_options: {
            bicycle: {
              bicycle_type: "hybrid",
              use_roads: BICYCLE_USE_ROADS[routeRequest.safetyPreference],
            },
          },
          units: "miles",
          alternates: 2,
          shape_format: "polyline6",
          directions_options: { units: "miles" },
        }),
        signal: request.signal,
      });
      if (!response.ok) {
        const status = response.status === 400 || response.status === 404 ? 422 : 502;
        return respond(jsonError(
          status === 422
            ? "No reasonable bicycle route was found for those endpoints."
            : `Routing service unavailable: provider returned HTTP ${response.status}.`,
          status,
          status === 422 ? { code: "no-reasonable-route" } : {},
        ), status === 422 ? "no-reasonable-route" : "provider-unavailable", routeRequest.safetyPreference);
      }
      const providerValue = await response.json();
      const graphVersionPromise = routingGraphVersion(
        providerValue,
        providerUrl,
        providerAccessHeaders,
        fetchImpl,
        request.signal,
      );
      const candidatesPromise = Promise.all(providerCandidates(providerValue).map((candidate) =>
        normalizeCandidate(
          candidate,
          routeRequest.safetyPreference,
          graphVersionPromise,
          providerUrl,
          providerAccessHeaders,
          enrichmentStore,
          fetchImpl,
          request.signal,
        ),
      ));
      const [graphVersion, candidates] = await Promise.all([graphVersionPromise, candidatesPromise]);
      const ranked = rankRouteCandidates(candidates, routeRequest.safetyPreference);
      const selected = ranked.find(
        (candidate) => !candidate.summary.hasBicycleProhibitedEdge,
      );
      if (!selected) {
        return respond(jsonError(
          "No reasonable bicycle route was found for the selected safety preference.",
          422,
          { code: "no-reasonable-route" },
        ), "no-reasonable-route", routeRequest.safetyPreference);
      }
      return respond(Response.json(
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
      ), "success", routeRequest.safetyPreference);
    } catch (error) {
      if (request.signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : "provider request failed";
      return respond(
        jsonError(`Routing service unavailable: ${detail}.`, 502),
        "provider-unavailable",
        routeRequest.safetyPreference,
      );
    }
  };
}

export function createRoutingHealthHandler({
  providerUrl,
  accessClientId,
  accessClientSecret,
  fetchImpl = fetch,
} = {}) {
  const providerAccessHeaders = routingProviderAccessHeaders(accessClientId, accessClientSecret);
  return async function handleRoutingHealth(request) {
    if (request.method !== "GET") return jsonError("Method not allowed.", 405);
    if (!providerUrl) {
      return jsonError("Routing provider is not configured.", 503, {
        status: "unavailable",
      });
    }
    if (!providerAccessHeaders) {
      return jsonError("Routing provider access is not configured.", 503, {
        status: "unavailable",
      });
    }
    try {
      const response = await fetchImpl(providerEndpoint(providerUrl, "/status"), {
        redirect: "manual",
        headers: providerRequestHeaders(providerAccessHeaders, { Accept: "application/json" }),
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
