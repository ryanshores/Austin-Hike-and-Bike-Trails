const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_MILE = 1609.344;
export const DIVERGENCE_WARNING_MILES = 0.25;
export const MANEUVER_PASS_TOLERANCE_MILES = 0.015;
export const MAX_PROGRESS_ADVANCE_MILES = 0.2;
export const ROUTE_MATCH_AMBIGUITY_METERS = 100;
export const ROUTE_MATCH_CORRIDOR_METERS = 35;

const routeAnalysisCache = new WeakMap();

function radians(value) {
  return value * Math.PI / 180;
}

function distanceMeters(start, end) {
  const latitudeDelta = radians(end[1] - start[1]);
  const longitudeDelta = radians(end[0] - start[0]);
  const startLatitude = radians(start[1]);
  const endLatitude = radians(end[1]);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeMeasure(coordinates) {
  const cumulativeMeters = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeMeters.push(cumulativeMeters[index - 1] + distanceMeters(coordinates[index - 1], coordinates[index]));
  }
  return cumulativeMeters;
}

function pointProjections(
  coordinates,
  cumulativeMeters,
  point,
  minAlongMeters = 0,
  maxAlongMeters = Number.POSITIVE_INFINITY,
) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(radians(point.latitude));
  const projections = [];

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    if (cumulativeMeters[index + 1] < minAlongMeters) continue;
    if (cumulativeMeters[index] > maxAlongMeters) break;
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const startX = (start[0] - point.longitude) * longitudeScale;
    const startY = (start[1] - point.latitude) * latitudeScale;
    const endX = (end[0] - point.longitude) * longitudeScale;
    const endY = (end[1] - point.latitude) * latitudeScale;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const squaredLength = deltaX ** 2 + deltaY ** 2;
    const nearestFraction = squaredLength === 0
      ? 0
      : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / squaredLength));
    const segmentMeters = cumulativeMeters[index + 1] - cumulativeMeters[index];
    const minimumFraction = segmentMeters === 0
      ? 0
      : Math.max(0, Math.min(1, (minAlongMeters - cumulativeMeters[index]) / segmentMeters));
    const maximumFraction = segmentMeters === 0
      ? 1
      : Math.max(0, Math.min(1, (maxAlongMeters - cumulativeMeters[index]) / segmentMeters));
    const fraction = Math.max(minimumFraction, Math.min(nearestFraction, maximumFraction));
    const projectedX = startX + deltaX * fraction;
    const projectedY = startY + deltaY * fraction;
    const distance = Math.hypot(projectedX, projectedY);
    const alongMeters = cumulativeMeters[index] + segmentMeters * fraction;
    projections.push({ alongMeters, distanceMeters: distance, segmentIndex: index });
  }

  return projections;
}

function projectPoint(
  coordinates,
  cumulativeMeters,
  point,
  minAlongMeters = 0,
  maxAlongMeters = Number.POSITIVE_INFINITY,
) {
  const projections = pointProjections(
    coordinates,
    cumulativeMeters,
    point,
    minAlongMeters,
    maxAlongMeters,
  );
  return projections.reduce(
    (best, candidate) => candidate.distanceMeters < best.distanceMeters ? candidate : best,
    { alongMeters: minAlongMeters, distanceMeters: Number.POSITIVE_INFINITY, segmentIndex: 0 },
  );
}

function segmentIndexAtAlong(cumulativeMeters, alongMeters) {
  for (let index = 1; index < cumulativeMeters.length; index += 1) {
    if (cumulativeMeters[index] > alongMeters) return index - 1;
  }
  return Math.max(0, cumulativeMeters.length - 2);
}

function routeMilesAtIndex(cumulativeMeters, index, scale) {
  if (!Number.isInteger(index)) return null;
  const boundedIndex = Math.max(0, Math.min(index, cumulativeMeters.length - 1));
  return cumulativeMeters[boundedIndex] / METERS_PER_MILE * scale;
}

function maneuverEndMiles(route, maneuverIndex, cumulativeMeters, scale) {
  const indexedEnd = routeMilesAtIndex(
    cumulativeMeters,
    route.maneuvers[maneuverIndex].endShapeIndex,
    scale,
  );
  if (indexedEnd !== null) return indexedEnd;
  const cumulativeManeuverMiles = route.maneuvers
    .slice(0, maneuverIndex + 1)
    .reduce((sum, maneuver) => sum + maneuver.distanceMiles, 0);
  return Math.min(route.totalMiles, cumulativeManeuverMiles);
}

function divergenceRanges(route, cumulativeMeters, scale) {
  let minimumAlongMeters = 0;
  return route.divergences.map((divergence) => {
    const coordinates = divergence.geometry.coordinates;
    const startPoint = {
      longitude: coordinates[0][0],
      latitude: coordinates[0][1],
    };
    const last = coordinates[coordinates.length - 1];
    const endPoint = {
      longitude: last[0],
      latitude: last[1],
    };
    const starts = pointProjections(
      route.geometry.coordinates,
      cumulativeMeters,
      startPoint,
      minimumAlongMeters,
    );
    const ends = pointProjections(
      route.geometry.coordinates,
      cumulativeMeters,
      endPoint,
      minimumAlongMeters,
    );
    const expectedMeters = scale > 0 ? divergence.miles / scale * METERS_PER_MILE : 0;
    let bestRange = null;
    let endIndex = 0;
    for (const start of starts) {
      const expectedEndAlongMeters = start.alongMeters + expectedMeters;
      while (endIndex < ends.length && ends[endIndex].alongMeters < expectedEndAlongMeters) {
        endIndex += 1;
      }
      for (const candidateIndex of [endIndex - 1, endIndex]) {
        const end = ends[candidateIndex];
        if (!end || end.alongMeters < start.alongMeters) continue;
        const score = start.distanceMeters + end.distanceMeters
          + Math.abs(end.alongMeters - expectedEndAlongMeters);
        if (!bestRange || score < bestRange.score) bestRange = { start, end, score };
      }
    }
    const startAlongMeters = bestRange?.start.alongMeters ?? minimumAlongMeters;
    const endAlongMeters = bestRange?.end.alongMeters ?? startAlongMeters;
    minimumAlongMeters = endAlongMeters;
    return {
      ...divergence,
      startMiles: startAlongMeters / METERS_PER_MILE * scale,
      endMiles: endAlongMeters / METERS_PER_MILE * scale,
    };
  });
}

export function guidanceQualityCanAdvance(quality) {
  return quality === "good" || quality === "fair";
}

export function prepareGuidanceRoute(route) {
  const cached = routeAnalysisCache.get(route);
  if (cached) return cached;
  const coordinates = route.geometry.coordinates;
  const cumulativeMeters = routeMeasure(coordinates);
  const measuredMiles = cumulativeMeters[cumulativeMeters.length - 1] / METERS_PER_MILE;
  const scale = measuredMiles > 0 ? route.totalMiles / measuredMiles : 1;
  const analysis = {
    coordinates,
    cumulativeMeters,
    divergenceRanges: divergenceRanges(route, cumulativeMeters, scale),
    scale,
  };
  routeAnalysisCache.set(route, analysis);
  return analysis;
}

function safetyWarningAtProgress(divergenceRanges, progressMiles) {
  const nextDivergence = divergenceRanges
    .find((divergence) => divergence.endMiles > progressMiles
      && divergence.startMiles - progressMiles <= DIVERGENCE_WARNING_MILES);
  return nextDivergence ? {
    reason: nextDivergence.reason,
    distanceMiles: Math.max(0, nextDivergence.startMiles - progressMiles),
    active: progressMiles >= nextDivergence.startMiles,
  } : null;
}

export function initialGuidanceProgress(route) {
  const analysis = prepareGuidanceRoute(route);
  return {
    progressMiles: 0,
    remainingMiles: route.totalMiles,
    maneuverIndex: route.maneuvers.length > 0 ? 0 : null,
    maneuverDistanceMiles: route.maneuvers[0]?.distanceMiles ?? null,
    safetyWarning: safetyWarningAtProgress(analysis.divergenceRanges, 0),
  };
}

export function updateGuidanceProgress(route, previous, point, accepted = true) {
  if (!accepted) return previous;
  const {
    coordinates,
    cumulativeMeters,
    divergenceRanges: preparedDivergenceRanges,
    scale,
  } = prepareGuidanceRoute(route);
  const maxProgressMiles = Math.min(
    route.totalMiles,
    previous.progressMiles + MAX_PROGRESS_ADVANCE_MILES,
  );
  const maxAlongMeters = scale > 0
    ? maxProgressMiles / scale * METERS_PER_MILE
    : cumulativeMeters[cumulativeMeters.length - 1];
  const previousAlongMeters = scale > 0
    ? previous.progressMiles / scale * METERS_PER_MILE
    : 0;
  const previousSegmentIndex = segmentIndexAtAlong(cumulativeMeters, previousAlongMeters);
  const nearestProjection = projectPoint(coordinates, cumulativeMeters, point);
  const routeMatchCorridorMeters = Math.max(
    ROUTE_MATCH_CORRIDOR_METERS,
    Math.min(75, Number(point.accuracyMeters) || 0),
  );
  if (nearestProjection.distanceMeters > routeMatchCorridorMeters) return previous;
  const boundedProjection = projectPoint(coordinates, cumulativeMeters, point, 0, maxAlongMeters);
  const projected = nearestProjection.segmentIndex > previousSegmentIndex + 1
    && nearestProjection.alongMeters > maxAlongMeters
    && boundedProjection.distanceMeters <= nearestProjection.distanceMeters + ROUTE_MATCH_AMBIGUITY_METERS
    ? boundedProjection
    : nearestProjection;
  const projectedMiles = projected.alongMeters / METERS_PER_MILE * scale;
  const progressMiles = Math.min(route.totalMiles, Math.max(previous.progressMiles, projectedMiles));

  let maneuverIndex = previous.maneuverIndex;
  while (maneuverIndex !== null && maneuverIndex < route.maneuvers.length) {
    const maneuverEnd = maneuverEndMiles(route, maneuverIndex, cumulativeMeters, scale);
    const reachedRouteEnd = maneuverEnd >= route.totalMiles && progressMiles >= route.totalMiles;
    if (!reachedRouteEnd && progressMiles < maneuverEnd + MANEUVER_PASS_TOLERANCE_MILES) break;
    maneuverIndex += 1;
    if (maneuverIndex >= route.maneuvers.length) maneuverIndex = null;
  }
  const maneuverEnd = maneuverIndex === null
    ? null
    : maneuverEndMiles(route, maneuverIndex, cumulativeMeters, scale);
  const maneuverDistanceMiles = maneuverIndex === null
    ? null
    : Math.max(0, maneuverEnd - progressMiles);

  const safetyWarning = safetyWarningAtProgress(preparedDivergenceRanges, progressMiles);

  return {
    progressMiles,
    remainingMiles: Math.max(0, route.totalMiles - progressMiles),
    maneuverIndex,
    maneuverDistanceMiles,
    safetyWarning,
  };
}
