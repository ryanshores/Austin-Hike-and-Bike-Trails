import {
  guidanceRouteDistanceMeters,
  guidanceRouteMatchCorridorMeters,
} from "./route-guidance-progress.js";
import { MAX_FIX_AGE_MS } from "./location-accuracy.js";

export const OFF_ROUTE_CONFIRMATION_SAMPLES = 3;
export const OFF_ROUTE_CLEAR_SAMPLES = 2;
export const MEANINGFUL_OFF_ROUTE_DISTANCE_METERS = 120;

export function initialOffRouteState() {
  return {
    status: "on-route",
    consecutiveOffRouteSamples: 0,
    consecutiveOnRouteSamples: 0,
    distanceMeters: null,
  };
}

export function updateOffRouteState(
  route,
  previous,
  point,
  progressMiles = 0,
  accepted = true,
) {
  if (!accepted) return previous;
  const distanceMeters = guidanceRouteDistanceMeters(route, point, progressMiles);
  const corridorMeters = guidanceRouteMatchCorridorMeters(point.accuracyMeters);
  if (distanceMeters > corridorMeters) {
    const consecutiveOffRouteSamples = previous.consecutiveOffRouteSamples + 1;
    const confirmed = consecutiveOffRouteSamples >= OFF_ROUTE_CONFIRMATION_SAMPLES
      || distanceMeters >= MEANINGFUL_OFF_ROUTE_DISTANCE_METERS;
    return {
      status: confirmed || previous.status === "off-route" ? "off-route" : "checking",
      consecutiveOffRouteSamples,
      consecutiveOnRouteSamples: 0,
      distanceMeters,
    };
  }

  const consecutiveOnRouteSamples = previous.consecutiveOnRouteSamples + 1;
  const remainsConfirmed = previous.status === "off-route"
    && consecutiveOnRouteSamples < OFF_ROUTE_CLEAR_SAMPLES;
  return {
    status: remainsConfirmed ? "off-route" : "on-route",
    consecutiveOffRouteSamples: 0,
    consecutiveOnRouteSamples,
    distanceMeters,
  };
}

export function rerouteFixIsFresh(point, now = Date.now()) {
  const timestamp = Number(point?.timestamp);
  return Number.isFinite(timestamp)
    && timestamp <= now
    && now - timestamp <= MAX_FIX_AGE_MS;
}

export function guidanceProgressAfterOffRouteCheck(previous, candidate, offRouteState) {
  return offRouteState.status === "on-route" ? candidate : previous;
}

export function rerouteRequest(guidance, point) {
  return {
    start: {
      latitude: point.latitude,
      longitude: point.longitude,
    },
    destination: {
      latitude: guidance.endpoints.destination.latitude,
      longitude: guidance.endpoints.destination.longitude,
    },
    safetyPreference: guidance.safetyPreference,
  };
}
