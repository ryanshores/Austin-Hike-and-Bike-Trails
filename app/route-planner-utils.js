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

export function nextComboboxOptionIndex(optionCount, activeIndex, key) {
  if (!Number.isInteger(optionCount) || optionCount < 1) return null;
  const current = Number.isInteger(activeIndex)
    ? Math.max(0, Math.min(optionCount - 1, activeIndex))
    : 0;
  if (key === "ArrowDown") return Math.min(optionCount - 1, current + 1);
  if (key === "ArrowUp") return Math.max(0, current - 1);
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  return null;
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

function normalizedManeuvers(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const instruction = String(item.instruction ?? "").trim();
    if (!instruction) return [];
    const type = item.type === null || item.type === undefined
      ? null
      : Number(item.type);
    const beginShapeIndex = item.beginShapeIndex === null || item.beginShapeIndex === undefined
      ? null
      : Number(item.beginShapeIndex);
    const endShapeIndex = item.endShapeIndex === null || item.endShapeIndex === undefined
      ? null
      : Number(item.endShapeIndex);
    if (
      (type !== null && !Number.isInteger(type)) ||
      (beginShapeIndex !== null && (!Number.isInteger(beginShapeIndex) || beginShapeIndex < 0)) ||
      (endShapeIndex !== null && (!Number.isInteger(endShapeIndex) || endShapeIndex < 0))
    ) {
      throw new Error("Route response contains invalid guidance details.");
    }
    return [{
      type,
      instruction,
      distanceMiles: finiteNonNegative(item.distanceMiles),
      beginShapeIndex,
      endShapeIndex,
      streetNames: Array.isArray(item.streetNames)
        ? item.streetNames.map((name) => String(name).trim()).filter(Boolean)
        : [],
    }];
  });
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
    maneuvers: normalizedManeuvers(route.maneuvers),
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
