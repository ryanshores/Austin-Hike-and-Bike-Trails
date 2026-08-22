export const SafetyClass = Object.freeze({
  ANY_BICYCLE_LEGAL: 0,
  BIKE_FACILITY: 1,
  PROTECTED: 2,
  FULLY_SEPARATED: 3,
});

export const SafetyPreference = Object.freeze({
  ANY_BICYCLE_LEGAL: "any-bicycle-legal",
  BIKE_FACILITY_OR_SAFER: "bike-facility-or-safer",
  PROTECTED_OR_SEPARATED: "protected-or-separated",
  FULLY_SEPARATED: "fully-separated",
});

export const SafetyFinding = Object.freeze({
  ATLAS: "atlas",
  OSM_FALLBACK: "osm-fallback",
  NOT_IN_TRAILS_LIST: "not-in-trails-list",
  UNKNOWN: "unknown",
  KNOWN_LESS_SAFE: "known-less-safe",
  BICYCLE_PROHIBITED: "bicycle-prohibited",
});

const PREFERENCE_MINIMUM = Object.freeze({
  [SafetyPreference.ANY_BICYCLE_LEGAL]: SafetyClass.ANY_BICYCLE_LEGAL,
  [SafetyPreference.BIKE_FACILITY_OR_SAFER]: SafetyClass.BIKE_FACILITY,
  [SafetyPreference.PROTECTED_OR_SEPARATED]: SafetyClass.PROTECTED,
  [SafetyPreference.FULLY_SEPARATED]: SafetyClass.FULLY_SEPARATED,
});

const CLASS_NAMES = Object.freeze({
  [SafetyClass.ANY_BICYCLE_LEGAL]: "any bicycle-legal path",
  [SafetyClass.BIKE_FACILITY]: "bike facility",
  [SafetyClass.PROTECTED]: "protected bike facility",
  [SafetyClass.FULLY_SEPARATED]: "fully separated path",
});

const PROHIBITED_ACCESS = new Set(["no", "private", "use_sidepath"]);
const RESTRICTED_GENERAL_ACCESS = new Set([
  "no",
  "private",
  "customers",
  "delivery",
  "agricultural",
  "forestry",
  "permit",
]);
const PERMITTED_BICYCLE_ACCESS = new Set(["yes", "designated", "permissive", "destination"]);
const NON_BICYCLE_TRAIL_TYPES = new Set(["footway", "steps", "pedestrian", "bridleway"]);
const LOW_STRESS_SURFACES = new Set([
  "",
  "asphalt",
  "concrete",
  "concrete:plates",
  "paved",
  "paving_stones",
  "sett",
]);

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function includesAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function speedKilometersPerHour(value) {
  const speed = normalized(value);
  const number = Number.parseFloat(speed);
  if (!Number.isFinite(number)) return null;
  return speed.includes("mph") ? number * 1.609344 : number;
}

function citySafetyClass(city) {
  const facility = normalized(city.BICYCLE_FACILITY);
  const lineType = normalized(city.LINE_TYPE);
  const comfort = normalized(city.BIKE_LEVEL_OF_COMFORT);
  if (!facility && !lineType && !comfort) return null;

  if (
    includesAny(lineType, ["off-street", "shared-use", "shared use"]) ||
    includesAny(facility, ["urban trail", "shared use path", "shared-use path", "off-street"])
  ) {
    return SafetyClass.FULLY_SEPARATED;
  }
  if (includesAny(facility, ["protected", "cycle track", "buffer", "wparking", "with parking"])) {
    return SafetyClass.PROTECTED;
  }
  if (
    includesAny(facility, ["bike lane", "bicycle lane", "neighborhood bikeway", "shared lane", "sharrow"]) ||
    includesAny(comfort, ["high comfort", "medium comfort", "low stress"])
  ) {
    return SafetyClass.BIKE_FACILITY;
  }
  return SafetyClass.ANY_BICYCLE_LEGAL;
}

function explicitBicyclePermission(osm) {
  return PERMITTED_BICYCLE_ACCESS.has(normalized(osm.bicycle));
}

function bicycleAccessProhibited(osm) {
  const bicycle = normalized(osm.bicycle);
  if (PROHIBITED_ACCESS.has(bicycle)) return true;
  if (explicitBicyclePermission(osm)) return false;
  return RESTRICTED_GENERAL_ACCESS.has(normalized(osm.access));
}

function sideCyclewayValue(osm, side) {
  return normalized(osm[`cycleway:${side}`]);
}

function sideSeparationValue(osm, side) {
  return normalized(osm[`cycleway:${side}:separation`]);
}

function safetyClassForCycleway(osm, cycleway, separation) {
  const highway = normalized(osm.highway);
  if (
    highway === "cycleway" &&
    !includesAny(cycleway, ["lane", "shared_lane"]) &&
    !includesAny(separation, ["no", "none"])
  ) {
    return SafetyClass.FULLY_SEPARATED;
  }
  if (
    includesAny(cycleway, ["track", "separate"]) ||
    includesAny(separation, ["physical", "kerb", "curb", "bollard", "parking", "barrier"])
  ) {
    return SafetyClass.PROTECTED;
  }
  if (includesAny(cycleway, ["lane", "shared_lane", "share_busway"]) || normalized(osm.cyclestreet) === "yes") {
    return SafetyClass.BIKE_FACILITY;
  }
  const maximumSpeed = speedKilometersPerHour(osm.maxspeed);
  const lowSpeedStreet =
    highway === "living_street" ||
    (["residential", "service"].includes(highway) && maximumSpeed !== null && maximumSpeed <= 32.2);
  if (lowSpeedStreet && LOW_STRESS_SURFACES.has(normalized(osm.surface))) {
    return SafetyClass.BIKE_FACILITY;
  }
  return SafetyClass.ANY_BICYCLE_LEGAL;
}

function osmSafetyClass(osm, travelDirection = null) {
  const highway = normalized(osm.highway);
  if (bicycleAccessProhibited(osm)) return null;
  if (NON_BICYCLE_TRAIL_TYPES.has(highway) && !explicitBicyclePermission(osm)) return null;

  const generalCycleway = [osm.cycleway, osm["cycleway:both"]].map(normalized).join(" ");
  const generalSeparation = [osm.separation, osm["cycleway:separation"]].map(normalized).join(" ");
  const sideForDirection = travelDirection === "forward"
    ? "right"
    : travelDirection === "backward"
      ? "left"
      : null;

  if (sideForDirection) {
    const sideCycleway = sideCyclewayValue(osm, sideForDirection);
    const sideSeparation = sideSeparationValue(osm, sideForDirection);
    return safetyClassForCycleway(
      osm,
      sideCycleway || generalCycleway,
      sideSeparation || generalSeparation,
    );
  }

  const leftCycleway = sideCyclewayValue(osm, "left");
  const rightCycleway = sideCyclewayValue(osm, "right");
  const leftSeparation = sideSeparationValue(osm, "left");
  const rightSeparation = sideSeparationValue(osm, "right");
  if (leftCycleway || rightCycleway || leftSeparation || rightSeparation) {
    return Math.min(
      safetyClassForCycleway(osm, leftCycleway || generalCycleway, leftSeparation || generalSeparation),
      safetyClassForCycleway(osm, rightCycleway || generalCycleway, rightSeparation || generalSeparation),
    );
  }
  return safetyClassForCycleway(osm, generalCycleway, generalSeparation);
}

function unknownOsmData(osm) {
  return !osm || Object.keys(osm).length === 0 || (!osm.highway && !osm.bicycle && !osm.cycleway);
}

export function classifyRouteEdge({
  city = null,
  osm = {},
  source = "osm",
  travelDirection = null,
} = {}) {
  const cityClass = citySafetyClass(city ?? {});
  if (cityClass !== null) {
    return {
      safetyClass: cityClass,
      finding: cityClass === SafetyClass.ANY_BICYCLE_LEGAL
        ? SafetyFinding.KNOWN_LESS_SAFE
        : SafetyFinding.ATLAS,
      source: "city",
      reason: CLASS_NAMES[cityClass],
    };
  }

  const osmClass = osmSafetyClass(osm, travelDirection);
  const highway = normalized(osm?.highway);
  if (
    bicycleAccessProhibited(osm) ||
    (NON_BICYCLE_TRAIL_TYPES.has(highway) && !explicitBicyclePermission(osm))
  ) {
    return {
      safetyClass: null,
      finding: SafetyFinding.BICYCLE_PROHIBITED,
      source: "osm",
      reason: "bicycles are not explicitly permitted",
    };
  }
  if (unknownOsmData(osm)) {
    return {
      safetyClass: SafetyClass.ANY_BICYCLE_LEGAL,
      finding: SafetyFinding.UNKNOWN,
      source,
      reason: "safety data is unknown",
    };
  }

  const finding = source === "atlas-trail"
    ? SafetyFinding.ATLAS
    : SafetyFinding.NOT_IN_TRAILS_LIST;
  return {
    safetyClass: osmClass,
    finding,
    source: "osm",
    reason: finding === SafetyFinding.NOT_IN_TRAILS_LIST
      ? "not in the Austin Trails list"
      : CLASS_NAMES[osmClass],
  };
}

export function minimumSafetyClass(preference) {
  const minimum = PREFERENCE_MINIMUM[preference];
  if (minimum === undefined) throw new Error(`Unknown safety preference: ${preference}`);
  return minimum;
}

export function meetsSafetyPreference(edge, preference) {
  return edge.safetyClass !== null && edge.safetyClass >= minimumSafetyClass(preference);
}

function edgeReason(edge) {
  if (edge.finding === SafetyFinding.BICYCLE_PROHIBITED) return "bicycles are prohibited";
  if (edge.finding === SafetyFinding.NOT_IN_TRAILS_LIST) return "not in the Austin Trails list";
  if (edge.finding === SafetyFinding.UNKNOWN) return "safety data is unknown";
  return edge.reason || CLASS_NAMES[edge.safetyClass] || "known less-safe connection";
}

function mergeGeometry(edges) {
  const coordinates = [];
  for (const edge of edges) {
    const edgeCoordinates = edge.geometry?.coordinates ?? [];
    for (const coordinate of edgeCoordinates) {
      const previous = coordinates.at(-1);
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
        coordinates.push(coordinate);
      }
    }
  }
  return { type: "LineString", coordinates };
}

export function summarizeRoute(edges, preference) {
  const minimum = minimumSafetyClass(preference);
  const mileageBySafetyClass = Object.fromEntries(
    Object.values(SafetyClass).map((safetyClass) => [safetyClass, 0]),
  );
  const divergences = [];
  let active = [];
  let totalMiles = 0;
  let totalAscentFeet = 0;
  let totalDescentFeet = 0;

  const closeDivergence = () => {
    if (active.length === 0) return;
    const miles = active.reduce((sum, edge) => sum + finiteNonNegative(edge.miles), 0);
    const reasons = [...new Set(active.map(edgeReason))];
    divergences.push({
      miles,
      edgeCount: active.length,
      reason: reasons.join("; "),
      geometry: mergeGeometry(active),
      minimumSafetyClass: Math.min(...active.map((edge) => edge.safetyClass ?? -1)),
    });
    active = [];
  };

  for (const edge of edges) {
    const miles = finiteNonNegative(edge.miles);
    totalMiles += miles;
    totalAscentFeet += finiteNonNegative(edge.ascentFeet);
    totalDescentFeet += finiteNonNegative(edge.descentFeet);
    if (edge.safetyClass !== null && mileageBySafetyClass[edge.safetyClass] !== undefined) {
      mileageBySafetyClass[edge.safetyClass] += miles;
    }
    if (edge.safetyClass === null || edge.safetyClass < minimum) active.push(edge);
    else closeDivergence();
  }
  closeDivergence();

  return {
    preference,
    totalMiles,
    totalAscentFeet,
    totalDescentFeet,
    mileageBySafetyClass,
    divergenceCount: divergences.length,
    divergenceMiles: divergences.reduce((sum, divergence) => sum + divergence.miles, 0),
    divergences,
    hasBicycleProhibitedEdge: edges.some((edge) => edge.finding === SafetyFinding.BICYCLE_PROHIBITED),
  };
}

export function candidateRank(candidate, preference) {
  const summary = Array.isArray(candidate.edges)
    ? summarizeRoute(candidate.edges, preference)
    : candidate.summary?.preference === preference
      ? candidate.summary
      : null;
  if (!summary) {
    throw new Error("Candidate requires route edges or a summary for the requested safety preference.");
  }
  return [
    summary.hasBicycleProhibitedEdge ? 1 : 0,
    summary.divergenceCount,
    summary.divergenceMiles,
    finiteNonNegative(candidate.trafficExposureCost, Number.MAX_SAFE_INTEGER),
    summary.totalMiles,
    summary.totalAscentFeet,
  ];
}

export function compareCandidates(left, right, preference) {
  const leftRank = candidateRank(left, preference);
  const rightRank = candidateRank(right, preference);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  }
  return 0;
}

export function rankRouteCandidates(candidates, preference) {
  return [...candidates].sort((left, right) => compareCandidates(left, right, preference));
}
