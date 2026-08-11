const DEFAULT_START = Object.freeze({ latitude: 30.2672, longitude: -97.7431 });
const DEFAULT_DESTINATION = Object.freeze({ latitude: 30.2604, longitude: -97.7611 });
const DEFAULT_PREFERENCE = "protected-or-separated";
const FORBIDDEN_CLIENT_FIELDS = /eta|duration|arrival|speed|time/i;

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

export function stagingBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Staging base URL must be an HTTPS origin without credentials, query, or fragment.");
  }
  if (url.pathname !== "/") throw new Error("Staging base URL must not include a path.");
  return url;
}

export function coordinate(value, label) {
  const [latitude, longitude, extra] = String(value).split(",");
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  if (extra || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    throw new Error(`${label} must be latitude,longitude.`);
  }
  return point;
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Route returned invalid ${label}.`);
}

function assertLineString(value, label) {
  if (value?.type !== "LineString" || !Array.isArray(value.coordinates) ||
      value.coordinates.length < 2 || !value.coordinates.every(validCoordinate)) {
    throw new Error(`Route response did not include usable ${label} geometry.`);
  }
}

function assertNoForbiddenFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CLIENT_FIELDS.test(key)) {
      throw new Error(`Route exposed forbidden client field ${key}.`);
    }
    assertNoForbiddenFields(child);
  }
}

function assertManeuver(value) {
  if (!String(value?.instruction ?? "").trim()) {
    throw new Error("Route returned a maneuver without an instruction.");
  }
  assertFiniteNonNegative(value.distanceMiles, "maneuver distanceMiles");
  for (const field of ["type", "beginShapeIndex", "endShapeIndex"]) {
    const fieldValue = value[field];
    if (fieldValue !== null && fieldValue !== undefined &&
        (!Number.isInteger(fieldValue) || fieldValue < 0)) {
      throw new Error(`Route returned an invalid maneuver ${field}.`);
    }
  }
}

export function assertRoutingHealth(value) {
  if (value?.status !== "ok" || value?.provider !== "valhalla") {
    throw new Error("Routing health did not report an available Valhalla provider.");
  }
  if (!String(value.version ?? "").trim() || !String(value.routingGraphVersion ?? "").trim()) {
    throw new Error("Routing health did not report provider and graph versions.");
  }
}

export function assertPublicRoute(value, preference) {
  if (value?.safetyPreference !== preference) {
    throw new Error("Route response did not preserve the requested safety preference.");
  }
  const route = value?.route;
  assertLineString(route?.geometry, "route");
  for (const field of ["totalMiles", "totalAscentFeet", "totalDescentFeet", "divergenceMiles"]) {
    assertFiniteNonNegative(route[field], field);
  }
  if (!Number.isInteger(route.divergenceCount) || route.divergenceCount < 0 ||
      !Array.isArray(route.divergences) || route.divergences.length !== route.divergenceCount ||
      !Array.isArray(route.maneuvers) || !route.mileageBySafetyClass ||
      !String(route.versions?.dataset ?? "").trim() ||
      !String(route.versions?.routingGraph ?? "").trim()) {
    throw new Error("Route response did not satisfy the public route contract.");
  }
  for (const [safetyClass, miles] of Object.entries(route.mileageBySafetyClass)) {
    if (!/^\d+$/u.test(safetyClass)) throw new Error("Route returned an invalid safety mileage class.");
    assertFiniteNonNegative(miles, `mileageBySafetyClass.${safetyClass}`);
  }
  for (const divergence of route.divergences) {
    assertFiniteNonNegative(divergence?.miles, "divergence miles");
    if (!String(divergence?.reason ?? "").trim()) {
      throw new Error("Route returned a divergence without a reason.");
    }
    assertLineString(divergence.geometry, "divergence");
  }
  for (const maneuver of route.maneuvers) {
    assertManeuver(maneuver);
  }
  assertNoForbiddenFields(value);
}

async function jsonResponse(response, label) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
}

async function sameOriginJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, { ...options, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${label} redirected instead of responding from staging.`);
  }
  if (response.url && new URL(response.url).origin !== url.origin) {
    throw new Error(`${label} resolved to a different origin than staging.`);
  }
  return jsonResponse(response, label);
}

export async function verifyStagingRoutePlanner({
  baseUrl,
  start = DEFAULT_START,
  destination = DEFAULT_DESTINATION,
  safetyPreference = DEFAULT_PREFERENCE,
  fetchImpl = fetch,
} = {}) {
  const origin = stagingBaseUrl(baseUrl);
  const health = await sameOriginJson(
    fetchImpl,
    new URL("/api/routing-health", origin),
    { headers: { Accept: "application/json" } },
    "Routing health",
  );
  assertRoutingHealth(health);
  const route = await sameOriginJson(
    fetchImpl,
    new URL("/api/routes", origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ start, destination, safetyPreference }),
    },
    "Route request",
  );
  assertPublicRoute(route, safetyPreference);
  return {
    health: {
      version: health.version,
      routingGraphVersion: health.routingGraphVersion,
    },
    route: {
      totalMiles: route.route.totalMiles,
      divergenceCount: route.route.divergenceCount,
      divergenceMiles: route.route.divergenceMiles,
      safetyPreference,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const result = await verifyStagingRoutePlanner({
    baseUrl: required(args, "--base-url"),
    start: coordinate(option(args, "--start", `${DEFAULT_START.latitude},${DEFAULT_START.longitude}`), "Start"),
    destination: coordinate(
      option(args, "--destination", `${DEFAULT_DESTINATION.latitude},${DEFAULT_DESTINATION.longitude}`),
      "Destination",
    ),
    safetyPreference: option(args, "--safety-preference", DEFAULT_PREFERENCE),
  });
  console.log(JSON.stringify({ verified: true, ...result }));
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
