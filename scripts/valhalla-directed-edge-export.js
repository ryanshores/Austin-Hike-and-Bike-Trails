import { decodePolyline6 } from "../worker/routes.js";

const METERS_PER_DEGREE_LATITUDE = 111_320;
// Longer edge_walk traces can fail where a City line crosses a disconnected
// facility.  A short, overlapping shape preserves exact matching while keeping
// the request count bounded by the 20 m sampling contract.
const MAX_TRACE_SHAPE_POINTS = 16;
const TRACE_SAMPLE_SPACING_METERS = 20;

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function distanceMeters([longitudeA, latitudeA], [longitudeB, latitudeB]) {
  const longitudeScale = Math.cos(((latitudeA + latitudeB) / 2) * Math.PI / 180);
  return Math.hypot(
    (longitudeB - longitudeA) * METERS_PER_DEGREE_LATITUDE * longitudeScale,
    (latitudeB - latitudeA) * METERS_PER_DEGREE_LATITUDE,
  );
}

function lineStrings(feature, index) {
  const geometry = feature?.geometry;
  const lines = geometry?.type === "LineString"
    ? [geometry.coordinates]
    : geometry?.type === "MultiLineString"
      ? geometry.coordinates
      : null;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`City feature ${index} must have a LineString or MultiLineString geometry.`);
  }
  if (lines.some((line) => !Array.isArray(line) || line.length < 2 || !line.every(validCoordinate))) {
    throw new Error(`City feature ${index} has an invalid line geometry.`);
  }
  return lines;
}

function densifyLine(coordinates, maximumSpacingMeters = TRACE_SAMPLE_SPACING_METERS) {
  const result = [coordinates[0]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const distance = distanceMeters(start, end);
    const segments = Math.max(1, Math.ceil(distance / maximumSpacingMeters));
    for (let segment = 1; segment <= segments; segment += 1) {
      const fraction = segment / segments;
      result.push([
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ]);
    }
  }
  return result;
}

export function traceShapesForCityCollection(cityCollection) {
  if (cityCollection?.type !== "FeatureCollection" || !Array.isArray(cityCollection.features)) {
    throw new Error("City input must be a GeoJSON FeatureCollection.");
  }
  const shapes = [];
  for (const [featureIndex, feature] of cityCollection.features.entries()) {
    for (const line of lineStrings(feature, featureIndex)) {
      const denseLine = densifyLine(line);
      for (let start = 0; start < denseLine.length - 1; start += MAX_TRACE_SHAPE_POINTS - 1) {
        const shape = denseLine.slice(start, start + MAX_TRACE_SHAPE_POINTS);
        if (shape.length >= 2) shapes.push(shape);
      }
    }
  }
  return shapes;
}

function providerEndpoint(routingUrl, path) {
  const url = new URL(routingUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Routing URL must use HTTP or HTTPS.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url;
}

function requiredGraphVersion(status, expectedGraphVersion) {
  const graphVersion = String(status?.tileset_last_modified ?? "").trim();
  if (!graphVersion) throw new Error("Valhalla status did not return a routing graph version.");
  if (expectedGraphVersion && graphVersion !== expectedGraphVersion) {
    throw new Error(`Valhalla graph version ${graphVersion} does not match expected ${expectedGraphVersion}.`);
  }
  return graphVersion;
}

function edgeGeometry(shape, edge) {
  const begin = Number(edge?.begin_shape_index);
  const end = Number(edge?.end_shape_index);
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end < begin || end >= shape.length) {
    throw new Error("Valhalla returned an edge without valid shape indexes.");
  }
  const coordinates = shape.slice(begin, end + 1);
  if (coordinates.length < 2) throw new Error("Valhalla returned an edge without usable geometry.");
  return coordinates;
}

function isPartialEdge(edge) {
  // Valhalla emits either field only when the trace covers part of an edge.
  // A City fragment must not grant its classification to the untraced portion
  // of the directed graph edge identified by edge.id.
  return edge?.source_percent_along !== undefined || edge?.target_percent_along !== undefined;
}

function addFailure(failures, key) {
  failures.set(key, (failures.get(key) ?? 0) + 1);
}

function traceRequest(shape, shapeMatch = "edge_walk") {
  return {
    shape: shape.map(([longitude, latitude]) => ({ lat: latitude, lon: longitude })),
    shape_match: shapeMatch,
    costing: "bicycle",
    costing_options: { bicycle: { bicycle_type: "hybrid" } },
    filters: {
      attributes: [
        "edge.id",
        "edge.way_id",
        "edge.forward",
        "edge.length",
        "edge.begin_shape_index",
        "edge.end_shape_index",
        "shape",
      ],
      action: "include",
    },
  };
}

export async function exportDirectedEdges({
  cityCollection,
  routingUrl,
  expectedGraphVersion,
  concurrency = 4,
  fetchImpl = fetch,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Trace concurrency must be an integer from 1 through 8.");
  }
  const statusResponse = await fetchImpl(providerEndpoint(routingUrl, "/status"));
  if (!statusResponse.ok) throw new Error(`Valhalla status returned HTTP ${statusResponse.status}.`);
  const routingGraphVersion = requiredGraphVersion(await statusResponse.json(), expectedGraphVersion);
  const records = new Map();
  const shapes = traceShapesForCityCollection(cityCollection);
  const attributions = new Array(shapes.length);
  const traceFailures = new Map();
  let fallbackTracedShapes = 0;
  let partialEdgesOmitted = 0;
  let nextShape = 0;

  async function traceNextShape() {
    while (nextShape < shapes.length) {
      const shapeIndex = nextShape;
      nextShape += 1;
      const shape = shapes[shapeIndex];
      let response = await fetchImpl(providerEndpoint(routingUrl, "/trace_attributes"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(traceRequest(shape)),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          let error = null;
          try {
            error = await response.json();
          } catch {
            // The summary still records an untraced City shape without retaining
            // potentially large provider error payloads.
          }
          response = await fetchImpl(providerEndpoint(routingUrl, "/trace_attributes"), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(traceRequest(shape, "walk_or_snap")),
          });
          if (response.ok) {
            const fallback = await response.json();
            try {
              const tracedShape = decodePolyline6(String(fallback?.shape ?? ""));
              if (!Array.isArray(fallback?.edges) || fallback.edges.length === 0) {
                throw new Error("Valhalla walk_or_snap returned no directed edges for a City facility line.");
              }
              attributions[shapeIndex] = { edges: fallback.edges, shape: tracedShape };
              fallbackTracedShapes += 1;
              continue;
            } catch {
              addFailure(traceFailures, "200:invalid-fallback");
              attributions[shapeIndex] = null;
              continue;
            }
          }
          const code = String(error?.error_code ?? "unknown");
          addFailure(traceFailures, `${response.status}:${code}`);
          attributions[shapeIndex] = null;
          continue;
        }
        throw new Error(`Valhalla trace_attributes returned HTTP ${response.status}.`);
      }
      const traced = await response.json();
      try {
        const tracedShape = decodePolyline6(String(traced?.shape ?? ""));
        if (!Array.isArray(traced?.edges) || traced.edges.length === 0) {
          throw new Error("Valhalla trace_attributes returned no directed edges for a City facility line.");
        }
        attributions[shapeIndex] = { edges: traced.edges, shape: tracedShape };
      } catch {
        addFailure(traceFailures, "200:invalid-attribution");
        attributions[shapeIndex] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, shapes.length) }, traceNextShape));

  for (const attribution of attributions) {
    if (!attribution) continue;
    const { edges: attributed, shape } = attribution;
    const shapeRecords = [];
    try {
      for (const edge of attributed) {
        const edgeId = String(edge?.id ?? "").trim();
        if (!edgeId) throw new Error("Valhalla returned a directed edge without a stable ID.");
        if (isPartialEdge(edge)) {
          partialEdgesOmitted += 1;
          continue;
        }
        const coordinates = edgeGeometry(shape, edge);
        const travelDirection = typeof edge.forward === "boolean"
          ? edge.forward ? "forward" : "backward"
          : null;
        shapeRecords.push({
          type: "Feature",
          id: edgeId,
          properties: {
            edgeId,
            osmWayId: edge.way_id ?? null,
            travelDirection,
            osm: {},
          },
          geometry: { type: "LineString", coordinates },
        });
      }
    } catch {
      addFailure(traceFailures, "200:invalid-attribution");
      continue;
    }
    for (const record of shapeRecords) {
      const existing = records.get(record.id);
      if (existing && existing.properties.travelDirection !== record.properties.travelDirection) {
        throw new Error(`Valhalla returned conflicting directions for directed edge ${record.id}.`);
      }
      if (!existing) records.set(record.id, record);
    }
  }

  return {
    type: "FeatureCollection",
    routingGraphVersion,
    generator: "atlas-valhalla-trace-attributes",
    traceSummary: {
      shapes: shapes.length,
      tracedShapes: shapes.length - [...traceFailures.values()].reduce((total, value) => total + value, 0),
      fallbackTracedShapes,
      partialEdgesOmitted,
      untracedShapes: [...traceFailures.values()].reduce((total, value) => total + value, 0),
      failures: Object.fromEntries([...traceFailures.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    features: [...records.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
