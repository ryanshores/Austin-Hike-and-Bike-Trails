import { normalizePlannedRoute, SAFETY_OPTIONS } from "./route-planner-utils.js";

export const ROUTE_GUIDANCE_STORAGE_KEY = "atlas-route-guidance-v1";
export const ROUTE_GUIDANCE_VERSION = 1;
export const ROUTE_GUIDANCE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const SAFETY_PREFERENCES = new Set(SAFETY_OPTIONS.map((option) => option.value));

function normalizedEndpoint(value, label) {
  const name = String(value?.label ?? "").trim();
  const latitude = Number(value?.latitude);
  const longitude = Number(value?.longitude);
  if (
    !name ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error(`Route guidance contains an invalid ${label}.`);
  }
  return { label: name, latitude, longitude };
}

export function normalizeRouteGuidancePayload(value, now = Date.now()) {
  if (value?.version !== ROUTE_GUIDANCE_VERSION) {
    throw new Error("Route guidance uses an unsupported version.");
  }
  const createdAt = Number(value.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt > now + 60_000 ||
    now - createdAt > ROUTE_GUIDANCE_MAX_AGE_MS
  ) {
    throw new Error("Route guidance is stale.");
  }
  if (!SAFETY_PREFERENCES.has(value.safetyPreference)) {
    throw new Error("Route guidance contains an invalid safety preference.");
  }
  return {
    version: ROUTE_GUIDANCE_VERSION,
    createdAt,
    safetyPreference: value.safetyPreference,
    endpoints: {
      start: normalizedEndpoint(value.endpoints?.start, "start"),
      destination: normalizedEndpoint(value.endpoints?.destination, "destination"),
    },
    route: normalizePlannedRoute({ route: value.route }),
  };
}

export function saveRouteGuidance(storage, value, now = Date.now()) {
  const payload = normalizeRouteGuidancePayload({
    ...value,
    version: ROUTE_GUIDANCE_VERSION,
    createdAt: now,
  }, now);
  storage.setItem(ROUTE_GUIDANCE_STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

export function loadRouteGuidance(storage, now = Date.now()) {
  try {
    const stored = storage.getItem(ROUTE_GUIDANCE_STORAGE_KEY);
    if (!stored) return null;
    return normalizeRouteGuidancePayload(JSON.parse(stored), now);
  } catch {
    try {
      storage.removeItem(ROUTE_GUIDANCE_STORAGE_KEY);
    } catch {
      // Invalid guidance can be ignored when storage cleanup is unavailable.
    }
    return null;
  }
}
