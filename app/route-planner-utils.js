export const SAFETY_OPTIONS = Object.freeze([
  {
    value: "any-bicycle-legal",
    label: "Any bicycle-legal path",
    note: "Regular streets and connectors are allowed.",
  },
  {
    value: "bike-facility-or-safer",
    label: "Bike facilities or safer",
    note: "Prefer bike lanes, bikeways, and separated paths.",
  },
  {
    value: "protected-or-separated",
    label: "Protected or separated",
    note: "Prefer protection from moving traffic.",
  },
  {
    value: "fully-separated",
    label: "Fully separated",
    note: "Prefer off-road and shared-use paths.",
  },
]);

export const SAFETY_CLASS_LABELS = Object.freeze([
  "Bicycle-legal connections",
  "Bike facilities",
  "Protected facilities",
  "Fully separated paths",
]);

export function swapEndpointQueries(queries) {
  return {
    start: String(queries?.destination ?? ""),
    destination: String(queries?.start ?? ""),
  };
}

export function routeRequestIsCurrent(activeRequest, request) {
  return activeRequest === request && !request.signal.aborted;
}

function finiteNonNegative(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Route response contains an invalid distance or elevation.");
  }
  return number;
}

function lineString(value) {
  if (value?.type !== "LineString" || !Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    throw new Error("Route response contains invalid map geometry.");
  }
  const coordinates = value.coordinates.map((coordinate) => {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2 ||
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1])
    ) {
      throw new Error("Route response contains invalid map geometry.");
    }
    return [coordinate[0], coordinate[1]];
  });
  return { type: "LineString", coordinates };
}

export function normalizePlannedRoute(value) {
  const route = value?.route;
  if (!route || typeof route !== "object") {
    throw new Error("Route response is missing a route.");
  }
  const mileageBySafetyClass = Object.fromEntries(
    SAFETY_CLASS_LABELS.map((_label, safetyClass) => [
      safetyClass,
      finiteNonNegative(route.mileageBySafetyClass?.[safetyClass] ?? 0),
    ]),
  );
  if (!Array.isArray(route.divergences)) {
    throw new Error("Route response contains invalid safety details.");
  }
  const divergences = route.divergences.map((divergence) => ({
    miles: finiteNonNegative(divergence?.miles),
    reason: String(divergence?.reason ?? "").trim() || "lower-safety connection",
    geometry: lineString(divergence?.geometry),
    minimumSafetyClass: Number.isInteger(divergence?.minimumSafetyClass)
      ? divergence.minimumSafetyClass
      : -1,
  }));
  const divergenceCount = finiteNonNegative(route.divergenceCount);
  if (!Number.isInteger(divergenceCount) || divergenceCount !== divergences.length) {
    throw new Error("Route response contains invalid safety details.");
  }

  return {
    geometry: lineString(route.geometry),
    totalMiles: finiteNonNegative(route.totalMiles),
    totalAscentFeet: finiteNonNegative(route.totalAscentFeet),
    totalDescentFeet: finiteNonNegative(route.totalDescentFeet),
    mileageBySafetyClass,
    divergenceCount,
    divergenceMiles: finiteNonNegative(route.divergenceMiles),
    divergences,
  };
}

export function routeErrorMessage(status, value) {
  if (status === 422 || value?.code === "no-reasonable-route") {
    return "No reasonable bicycle route was found. Try another endpoint or a more flexible safety preference.";
  }
  if (status === 429) return "Route planning is busy. Wait a moment and try again.";
  if (status === 503) return "Route planning is not available in this environment yet.";
  if (status === 400 && typeof value?.error === "string") return value.error;
  return "Route planning is temporarily unavailable. Try again shortly.";
}

export function formatMiles(value) {
  const miles = finiteNonNegative(value);
  if (miles === 0) return "0 mi";
  if (miles < 0.1) return "<0.1 mi";
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

export function formatFeet(value) {
  return `${Math.round(finiteNonNegative(value)).toLocaleString("en-US")} ft`;
}
