const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_MILE = 1609.344;
export const DIVERGENCE_WARNING_MILES = 0.25;
export const MANEUVER_PASS_TOLERANCE_MILES = 0.015;

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

function projectPoint(coordinates, cumulativeMeters, point) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(radians(point.latitude));
  let best = null;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const startX = (start[0] - point.longitude) * longitudeScale;
    const startY = (start[1] - point.latitude) * latitudeScale;
    const endX = (end[0] - point.longitude) * longitudeScale;
    const endY = (end[1] - point.latitude) * latitudeScale;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const squaredLength = deltaX ** 2 + deltaY ** 2;
    const fraction = squaredLength === 0
      ? 0
      : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / squaredLength));
    const projectedX = startX + deltaX * fraction;
    const projectedY = startY + deltaY * fraction;
    const distance = Math.hypot(projectedX, projectedY);
    const alongMeters = cumulativeMeters[index]
      + (cumulativeMeters[index + 1] - cumulativeMeters[index]) * fraction;
    if (!best || distance < best.distanceMeters) best = { alongMeters, distanceMeters: distance };
  }

  return best ?? { alongMeters: 0, distanceMeters: Number.POSITIVE_INFINITY };
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
  return route.divergences.map((divergence) => {
    const coordinates = divergence.geometry.coordinates;
    const start = projectPoint(route.geometry.coordinates, cumulativeMeters, {
      longitude: coordinates[0][0],
      latitude: coordinates[0][1],
    }).alongMeters / METERS_PER_MILE * scale;
    const last = coordinates[coordinates.length - 1];
    const end = projectPoint(route.geometry.coordinates, cumulativeMeters, {
      longitude: last[0],
      latitude: last[1],
    }).alongMeters / METERS_PER_MILE * scale;
    return { ...divergence, startMiles: Math.min(start, end), endMiles: Math.max(start, end) };
  }).sort((left, right) => left.startMiles - right.startMiles);
}

export function initialGuidanceProgress(route) {
  return {
    progressMiles: 0,
    remainingMiles: route.totalMiles,
    maneuverIndex: route.maneuvers.length > 0 ? 0 : null,
    maneuverDistanceMiles: route.maneuvers[0]?.distanceMiles ?? null,
    safetyWarning: null,
  };
}

export function updateGuidanceProgress(route, previous, point, accepted = true) {
  if (!accepted) return previous;
  const coordinates = route.geometry.coordinates;
  const cumulativeMeters = routeMeasure(coordinates);
  const measuredMiles = cumulativeMeters[cumulativeMeters.length - 1] / METERS_PER_MILE;
  const scale = measuredMiles > 0 ? route.totalMiles / measuredMiles : 1;
  const projected = projectPoint(coordinates, cumulativeMeters, point);
  const projectedMiles = projected.alongMeters / METERS_PER_MILE * scale;
  const progressMiles = Math.min(route.totalMiles, Math.max(previous.progressMiles, projectedMiles));

  let maneuverIndex = previous.maneuverIndex;
  while (maneuverIndex !== null && maneuverIndex < route.maneuvers.length) {
    const maneuverEnd = maneuverEndMiles(route, maneuverIndex, cumulativeMeters, scale);
    if (progressMiles < maneuverEnd + MANEUVER_PASS_TOLERANCE_MILES) break;
    maneuverIndex += 1;
    if (maneuverIndex >= route.maneuvers.length) maneuverIndex = null;
  }
  const maneuverEnd = maneuverIndex === null
    ? null
    : maneuverEndMiles(route, maneuverIndex, cumulativeMeters, scale);
  const maneuverDistanceMiles = maneuverIndex === null
    ? null
    : Math.max(0, maneuverEnd - progressMiles);

  const nextDivergence = divergenceRanges(route, cumulativeMeters, scale)
    .find((divergence) => divergence.endMiles > progressMiles
      && divergence.startMiles - progressMiles <= DIVERGENCE_WARNING_MILES);
  const safetyWarning = nextDivergence ? {
    reason: nextDivergence.reason,
    distanceMiles: Math.max(0, nextDivergence.startMiles - progressMiles),
    active: progressMiles >= nextDivergence.startMiles,
  } : null;

  return {
    progressMiles,
    remainingMiles: Math.max(0, route.totalMiles - progressMiles),
    maneuverIndex,
    maneuverDistanceMiles,
    safetyWarning,
  };
}
