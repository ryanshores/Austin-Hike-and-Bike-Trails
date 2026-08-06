import {
  SafetyClass,
  SafetyFinding,
  classifyRouteEdge,
} from "../worker/route-safety.js";
import { distanceMeters, pointToSegmentMeters } from "./conflation-evaluator.js";

const METERS_PER_MILE = 1_609.344;
const METERS_PER_DEGREE_LATITUDE = 111_320;
const AUSTIN_LONGITUDE_SCALE = Math.cos((30.2672 * Math.PI) / 180);

function rounded(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function lineStrings(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function safetyFields(feature) {
  const properties = feature?.properties ?? {};
  return {
    BICYCLE_FACILITY: String(properties.BICYCLE_FACILITY ?? "").trim(),
    LINE_TYPE: String(properties.LINE_TYPE ?? "").trim(),
    BIKE_LEVEL_OF_COMFORT: String(properties.BIKE_LEVEL_OF_COMFORT ?? "").trim(),
  };
}

function safetyKey(fields) {
  return JSON.stringify(Object.values(fields).map((value) =>
    value.toLowerCase().replaceAll(/\s+/g, " ")
  ));
}

function cellKey(longitudeIndex, latitudeIndex) {
  return `${longitudeIndex}:${latitudeIndex}`;
}

function createCityIndex(cityFeatures, toleranceMeters) {
  const latitudeCellSize = toleranceMeters / METERS_PER_DEGREE_LATITUDE;
  const longitudeCellSize = latitudeCellSize / AUSTIN_LONGITUDE_SCALE;
  const cells = new Map();
  const features = cityFeatures.map((feature, featureIndex) => ({
    feature,
    featureIndex,
    fields: safetyFields(feature),
    lines: lineStrings(feature).filter((coordinates) =>
      coordinates.length >= 2 && coordinates.every(validCoordinate)
    ),
  }));

  const addToCell = (longitudeIndex, latitudeIndex, featureIndex) => {
    const key = cellKey(longitudeIndex, latitudeIndex);
    const cell = cells.get(key) ?? new Set();
    cell.add(featureIndex);
    cells.set(key, cell);
  };

  for (const indexed of features) {
    for (const coordinates of indexed.lines) {
      for (let index = 1; index < coordinates.length; index += 1) {
        const start = coordinates[index - 1];
        const end = coordinates[index];
        const west = Math.min(start[0], end[0]) - longitudeCellSize;
        const east = Math.max(start[0], end[0]) + longitudeCellSize;
        const south = Math.min(start[1], end[1]) - latitudeCellSize;
        const north = Math.max(start[1], end[1]) + latitudeCellSize;
        for (
          let longitudeIndex = Math.floor(west / longitudeCellSize);
          longitudeIndex <= Math.floor(east / longitudeCellSize);
          longitudeIndex += 1
        ) {
          for (
            let latitudeIndex = Math.floor(south / latitudeCellSize);
            latitudeIndex <= Math.floor(north / latitudeCellSize);
            latitudeIndex += 1
          ) {
            addToCell(longitudeIndex, latitudeIndex, indexed.featureIndex);
          }
        }
      }
    }
  }

  return {
    candidates(point) {
      const longitudeIndex = Math.floor(point[0] / longitudeCellSize);
      const latitudeIndex = Math.floor(point[1] / latitudeCellSize);
      return [...(cells.get(cellKey(longitudeIndex, latitudeIndex)) ?? [])]
        .map((featureIndex) => features[featureIndex]);
    },
  };
}

function featureWithinTolerance(point, indexedFeature, toleranceMeters) {
  return indexedFeature.lines.some((coordinates) =>
    coordinates.slice(1).some((end, index) =>
      pointToSegmentMeters(point, coordinates[index], end) <= toleranceMeters
    )
  );
}

function sampleLine(coordinates, maximumSpacingMeters) {
  const samples = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const segmentMeters = distanceMeters(start, end);
    if (segmentMeters === 0) continue;
    const count = Math.max(1, Math.ceil(segmentMeters / maximumSpacingMeters));
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      const fraction = (sampleIndex + 0.5) / count;
      samples.push({
        point: [
          start[0] + (end[0] - start[0]) * fraction,
          start[1] + (end[1] - start[1]) * fraction,
        ],
        miles: segmentMeters / count / METERS_PER_MILE,
      });
    }
  }
  return samples;
}

function edgeProperties(feature) {
  const properties = feature?.properties ?? {};
  const edgeId = properties.edgeId ?? properties.edge_id ?? feature?.id;
  if (edgeId === undefined || edgeId === null || String(edgeId).trim() === "") {
    throw new Error("Every routing edge requires a stable edgeId, edge_id, or GeoJSON feature id.");
  }
  if (feature?.geometry?.type !== "LineString" ||
      feature.geometry.coordinates.length < 2 ||
      !feature.geometry.coordinates.every(validCoordinate)) {
    throw new Error(`Routing edge ${edgeId} must have a valid LineString geometry.`);
  }
  return {
    edgeId: String(edgeId),
    osmWayId: properties.osmWayId ?? properties.osm_way_id ?? properties.osm_id ?? null,
    travelDirection: properties.travelDirection ?? properties.travel_direction ?? null,
    osm: properties.osm && typeof properties.osm === "object" ? properties.osm : {},
  };
}

function conservativeCityConflict(osmClassification, reason) {
  if (osmClassification.finding === SafetyFinding.BICYCLE_PROHIBITED) {
    return osmClassification;
  }
  return {
    safetyClass: SafetyClass.ANY_BICYCLE_LEGAL,
    finding: SafetyFinding.UNKNOWN,
    source: "city-osm",
    reason,
  };
}

function classifyEdge(feature, cityIndex, options) {
  const properties = edgeProperties(feature);
  const totals = { routeMiles: 0, matchedMiles: 0, ambiguousMiles: 0, unmatchedMiles: 0 };
  const matchedFields = new Map();

  for (const sample of sampleLine(feature.geometry.coordinates, options.sampleSpacingMeters)) {
    totals.routeMiles += sample.miles;
    const matches = cityIndex.candidates(sample.point).filter((candidate) =>
      featureWithinTolerance(sample.point, candidate, options.toleranceMeters)
    );
    if (matches.length === 0) {
      totals.unmatchedMiles += sample.miles;
      continue;
    }
    const keys = new Set(matches.map((match) => safetyKey(match.fields)));
    if (keys.size !== 1) {
      totals.ambiguousMiles += sample.miles;
      continue;
    }
    const match = matches[0];
    matchedFields.set(safetyKey(match.fields), match.fields);
    totals.matchedMiles += sample.miles;
  }

  const coverageRatio = totals.routeMiles === 0 ? 0 : totals.matchedMiles / totals.routeMiles;
  const osmClassification = classifyRouteEdge({
    osm: properties.osm,
    travelDirection: properties.travelDirection,
  });
  let matchStatus = "unmatched";
  let city = null;
  let classification = osmClassification;

  if (totals.ambiguousMiles > 0 || matchedFields.size > 1) {
    matchStatus = "ambiguous";
    classification = conservativeCityConflict(
      osmClassification,
      "conflicting City safety data; bicycle-legal fallback",
    );
  } else if (matchedFields.size === 1 && coverageRatio >= options.minimumCoverage) {
    matchStatus = "matched";
    city = [...matchedFields.values()][0];
    classification = osmClassification.finding === SafetyFinding.BICYCLE_PROHIBITED
      ? osmClassification
      : classifyRouteEdge({
          city,
          osm: properties.osm,
          travelDirection: properties.travelDirection,
        });
  } else if (matchedFields.size === 1) {
    matchStatus = "partial";
    classification = conservativeCityConflict(
      osmClassification,
      "partial City safety coverage; bicycle-legal fallback",
    );
  }

  return {
    ...properties,
    cityMatch: {
      status: matchStatus,
      coverageRatio: rounded(coverageRatio, 4),
      matchedMiles: rounded(totals.matchedMiles),
      ambiguousMiles: rounded(totals.ambiguousMiles),
      unmatchedMiles: rounded(totals.unmatchedMiles),
    },
    city,
    classification,
  };
}

function validatedCollection(value, label) {
  if (value?.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error(`${label} must be a GeoJSON FeatureCollection.`);
  }
  return value.features;
}

function validatedManifest(manifest) {
  const required = [
    "cityDatasetVersion",
    "cityDatasetSha256",
    "routingEdgesSha256",
    "osmExtractSource",
    "osmExtractDate",
    "osmExtractChecksum",
    "routingGraphVersion",
    "valhallaImage",
  ];
  for (const field of required) {
    if (!manifest || !String(manifest[field] ?? "").trim()) {
      throw new Error(`Enrichment manifest requires ${field}.`);
    }
  }
  return Object.fromEntries(required.map((field) => [field, String(manifest[field])]));
}

export function buildRoutingEnrichment({
  cityCollection,
  routingEdgeCollection,
  manifest,
  toleranceMeters = 25,
  sampleSpacingMeters = 20,
  minimumCoverage = 0.8,
} = {}) {
  const cityFeatures = validatedCollection(cityCollection, "City facilities");
  const routingEdges = validatedCollection(routingEdgeCollection, "Routing edges");
  const pinnedManifest = validatedManifest(manifest);
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0) {
    throw new Error("Tolerance must be a positive finite number of meters.");
  }
  if (!Number.isFinite(sampleSpacingMeters) || sampleSpacingMeters <= 0) {
    throw new Error("Sample spacing must be a positive finite number of meters.");
  }
  if (!Number.isFinite(minimumCoverage) || minimumCoverage <= 0 || minimumCoverage > 1) {
    throw new Error("Minimum coverage must be greater than zero and no more than one.");
  }

  const cityIndex = createCityIndex(cityFeatures, toleranceMeters);
  const options = { toleranceMeters, sampleSpacingMeters, minimumCoverage };
  const edges = routingEdges.map((edge) => classifyEdge(edge, cityIndex, options));
  const statusCounts = Object.fromEntries(
    ["matched", "partial", "ambiguous", "unmatched"].map((status) => [
      status,
      edges.filter((edge) => edge.cityMatch.status === status).length,
    ]),
  );

  return {
    schemaVersion: 1,
    manifest: {
      ...pinnedManifest,
      toleranceMeters,
      sampleSpacingMeters,
      minimumCoverage,
    },
    summary: {
      edges: edges.length,
      cityMatches: statusCounts,
      bicycleLegalFallbackEdges: edges.filter((edge) =>
        edge.cityMatch.status !== "matched" &&
        edge.classification.safetyClass === SafetyClass.ANY_BICYCLE_LEGAL
      ).length,
      bicycleProhibitedEdges: edges.filter((edge) =>
        edge.classification.finding === SafetyFinding.BICYCLE_PROHIBITED
      ).length,
    },
    edges,
  };
}
