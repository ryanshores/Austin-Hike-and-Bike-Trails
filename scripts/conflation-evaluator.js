const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_MILE = 1_609.344;

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function assertLineString(geometry, label) {
  if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || !geometry.coordinates.every(validCoordinate)) {
    throw new Error(`${label} must be a GeoJSON LineString with at least two finite coordinates.`);
  }
}

function radians(value) {
  return (value * Math.PI) / 180;
}

export function distanceMeters(left, right) {
  const latitudeDelta = radians(right[1] - left[1]);
  const longitudeDelta = radians(right[0] - left[0]);
  const leftLatitude = radians(left[1]);
  const rightLatitude = radians(right[1]);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function localMeters(point, origin) {
  return {
    x: radians(point[0] - origin[0]) * EARTH_RADIUS_METERS * Math.cos(radians(origin[1])),
    y: radians(point[1] - origin[1]) * EARTH_RADIUS_METERS,
  };
}

export function pointToSegmentMeters(point, start, end) {
  const localStart = localMeters(start, point);
  const localEnd = localMeters(end, point);
  const deltaX = localEnd.x - localStart.x;
  const deltaY = localEnd.y - localStart.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (lengthSquared === 0) return Math.hypot(localStart.x, localStart.y);
  const fraction = Math.max(0, Math.min(1, -(localStart.x * deltaX + localStart.y * deltaY) / lengthSquared));
  return Math.hypot(localStart.x + fraction * deltaX, localStart.y + fraction * deltaY);
}

function lineSegments(geometry) {
  assertLineString(geometry, "Route geometry");
  return geometry.coordinates.slice(1).map((end, index) => [geometry.coordinates[index], end]);
}

function facilityLines(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === "LineString") return [geometry];
  if (geometry?.type === "MultiLineString") return geometry.coordinates.map((coordinates) => ({ type: "LineString", coordinates }));
  return [];
}

function closestFacility(point, features, toleranceMeters) {
  const matches = [];
  for (const feature of features) {
    for (const geometry of facilityLines(feature)) {
      if (geometry.coordinates.length < 2 || !geometry.coordinates.every(validCoordinate)) continue;
      for (const [start, end] of lineSegments(geometry)) {
        const distance = pointToSegmentMeters(point, start, end);
        if (distance <= toleranceMeters) matches.push({ feature, distance });
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((left, right) => left.distance - right.distance);
  return matches;
}

function normalizedSafetyField(value) {
  return String(value ?? "").trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function facilitySafetyKey(feature) {
  const properties = feature?.properties ?? {};
  return JSON.stringify([
    normalizedSafetyField(properties.BICYCLE_FACILITY),
    normalizedSafetyField(properties.LINE_TYPE),
    normalizedSafetyField(properties.BIKE_LEVEL_OF_COMFORT),
  ]);
}

function facilityLabel(feature) {
  const properties = feature?.properties ?? {};
  const fields = [
    properties.BICYCLE_FACILITY,
    properties.LINE_TYPE,
    properties.BIKE_LEVEL_OF_COMFORT,
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  return fields.join(" · ") || "unlabeled City facility";
}

function sampleSegment(start, end, maximumSpacingMeters) {
  const lengthMeters = distanceMeters(start, end);
  if (lengthMeters === 0) return [];
  const sampleCount = Math.max(1, Math.ceil(lengthMeters / maximumSpacingMeters));
  return Array.from({ length: sampleCount }, (_, index) => {
    const fraction = (index + 0.5) / sampleCount;
    return { point: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction], miles: lengthMeters / sampleCount / METERS_PER_MILE };
  });
}

/** Measures City-geometry coverage without assigning a safety class to unknown or contradictory samples. */
export function evaluateConflation({ route, cityFeatures, toleranceMeters = 25, sampleSpacingMeters = 20 } = {}) {
  assertLineString(route, "Route geometry");
  if (!Array.isArray(cityFeatures)) throw new Error("City features must be an array.");
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0) throw new Error("Tolerance must be a positive finite number of meters.");
  if (!Number.isFinite(sampleSpacingMeters) || sampleSpacingMeters <= 0) throw new Error("Sample spacing must be a positive finite number of meters.");

  const summary = { routeMiles: 0, matchedMiles: 0, ambiguousMiles: 0, unmatchedMiles: 0, samples: 0, matchedSamples: 0, ambiguousSamples: 0, unmatchedSamples: 0, facilityMiles: {} };
  for (const [start, end] of lineSegments(route)) {
    for (const sample of sampleSegment(start, end, sampleSpacingMeters)) {
      summary.samples += 1;
      summary.routeMiles += sample.miles;
      const matches = closestFacility(sample.point, cityFeatures, toleranceMeters);
      if (!matches) {
        summary.unmatchedSamples += 1;
        summary.unmatchedMiles += sample.miles;
        continue;
      }
      const safetyKeys = new Set(matches.map(({ feature }) => facilitySafetyKey(feature)));
      if (safetyKeys.size > 1) {
        summary.ambiguousSamples += 1;
        summary.ambiguousMiles += sample.miles;
        continue;
      }
      const label = facilityLabel(matches[0].feature);
      summary.matchedSamples += 1;
      summary.matchedMiles += sample.miles;
      summary.facilityMiles[label] = (summary.facilityMiles[label] ?? 0) + sample.miles;
    }
  }
  const rounded = (value) => Number(value.toFixed(4));
  return {
    ...summary,
    routeMiles: rounded(summary.routeMiles),
    matchedMiles: rounded(summary.matchedMiles),
    ambiguousMiles: rounded(summary.ambiguousMiles),
    unmatchedMiles: rounded(summary.unmatchedMiles),
    facilityMiles: Object.fromEntries(Object.entries(summary.facilityMiles).map(([label, miles]) => [label, rounded(miles)])),
    coverageRatio: summary.routeMiles === 0 ? 0 : rounded(summary.matchedMiles / summary.routeMiles),
  };
}

export function boundsForLine(geometry, paddingDegrees = 0.002) {
  assertLineString(geometry, "Route geometry");
  if (!Number.isFinite(paddingDegrees) || paddingDegrees < 0) throw new Error("Padding must be a non-negative finite number of degrees.");
  const longitudes = geometry.coordinates.map(([longitude]) => longitude);
  const latitudes = geometry.coordinates.map(([, latitude]) => latitude);
  const rounded = (value) => Number(value.toFixed(6));
  return {
    west: rounded(Math.min(...longitudes) - paddingDegrees),
    south: rounded(Math.min(...latitudes) - paddingDegrees),
    east: rounded(Math.max(...longitudes) + paddingDegrees),
    north: rounded(Math.max(...latitudes) + paddingDegrees),
  };
}
