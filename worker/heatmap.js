import { HttpError, authenticateRequest } from "./auth.js";

const EARTH_RADIUS_METERS = 6_371_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";
const SUPPORTED_RANGES = new Map([
  ["30d", 30 * DAY_MS],
  ["90d", 90 * DAY_MS],
  ["365d", 365 * DAY_MS],
  ["all", null],
]);
const MAX_VIEWPORT_DEGREES = 10;
const MAX_CELLS = 1_000;
const HEATMAP_RESOLUTIONS = [5, 6, 7];

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function distanceMeters(left, right) {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function midpoint(left, right) {
  return {
    latitude: (left.latitude + right.latitude) / 2,
    longitude: (left.longitude + right.longitude) / 2,
  };
}

export function geohash(latitude, longitude, precision) {
  let latitudeMin = -90;
  let latitudeMax = 90;
  let longitudeMin = -180;
  let longitudeMax = 180;
  let bits = 0;
  let bitCount = 0;
  let even = true;
  let value = "";

  while (value.length < precision) {
    const midpointValue = even
      ? (longitudeMin + longitudeMax) / 2
      : (latitudeMin + latitudeMax) / 2;
    const coordinate = even ? longitude : latitude;
    if (coordinate >= midpointValue) {
      bits = (bits << 1) + 1;
      if (even) longitudeMin = midpointValue;
      else latitudeMin = midpointValue;
    } else {
      bits <<= 1;
      if (even) longitudeMax = midpointValue;
      else latitudeMax = midpointValue;
    }
    even = !even;
    bitCount += 1;
    if (bitCount === 5) {
      value += GEOHASH_ALPHABET[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return value;
}

export function resolutionForZoom(zoom) {
  if (zoom <= 12) return 5;
  if (zoom <= 14) return 6;
  return 7;
}

export function heatCellContributions(points, completedAt) {
  const bucketStart = Math.floor(completedAt / DAY_MS) * DAY_MS;
  const contributions = new Map();
  for (let index = 1; index < points.length; index += 1) {
    const distance = distanceMeters(points[index - 1], points[index]);
    if (!Number.isFinite(distance) || distance <= 0) continue;
    const center = midpoint(points[index - 1], points[index]);
    for (const resolution of HEATMAP_RESOLUTIONS) {
      const cellId = geohash(center.latitude, center.longitude, resolution);
      const key = `${resolution}:${cellId}`;
      const existing = contributions.get(key);
      if (existing) {
        existing.distanceMeters += distance;
      } else {
        contributions.set(key, {
          resolution,
          cellId,
          bucketStart,
          latitude: center.latitude,
          longitude: center.longitude,
          distanceMeters: distance,
        });
      }
    }
  }
  return [...contributions.values()];
}

function parseBounds(value) {
  if (typeof value !== "string") throw new HttpError(400, "Heatmap bounds are required");
  const values = value.split(",");
  if (values.length !== 4 || values.some((entry) => entry.trim() === "")) throw new HttpError(400, "Invalid heatmap bounds");
  const [west, south, east, north] = values.map(Number);
  if (![west, south, east, north].every(Number.isFinite)
    || west < -180 || east > 180 || south < -90 || north > 90
    || west >= east || south >= north
    || east - west > MAX_VIEWPORT_DEGREES || north - south > MAX_VIEWPORT_DEGREES) {
    throw new HttpError(400, "Invalid heatmap bounds");
  }
  return { west, south, east, north };
}

function parseParameters(request, now) {
  const parameters = new URL(request.url).searchParams;
  if (parameters.get("scope") !== "mine") throw new HttpError(400, "Heatmap scope must be mine");
  const zoomValue = parameters.get("zoom");
  if (!zoomValue || !/^\d+$/u.test(zoomValue)) throw new HttpError(400, "Invalid heatmap zoom");
  const zoom = Number(zoomValue);
  if (zoom < 0 || zoom > 22) throw new HttpError(400, "Invalid heatmap zoom");
  const range = parameters.get("range") ?? "90d";
  if (!SUPPORTED_RANGES.has(range)) throw new HttpError(400, "Invalid heatmap range");
  const duration = SUPPORTED_RANGES.get(range);
  return {
    bounds: parseBounds(parameters.get("bounds")),
    resolution: resolutionForZoom(zoom),
    range,
    since: duration === null ? null : now - duration,
  };
}

async function getHeatmap(request, dependencies) {
  const user = await authenticateRequest(request, dependencies);
  const parameters = parseParameters(request, dependencies.now());
  const cells = await dependencies.db.prepare(
    `SELECT cell_id AS cellId, latitude, longitude,
            SUM(ride_count) AS rideCount, SUM(distance_meters) AS distanceMeters
       FROM ride_heat_cells
      WHERE user_id = ? AND resolution = ?
        AND latitude BETWEEN ? AND ?
        AND longitude BETWEEN ? AND ?
        AND (? IS NULL OR bucket_start >= ?)
      GROUP BY cell_id, latitude, longitude
      ORDER BY distanceMeters DESC, cellId ASC
      LIMIT ?`,
  ).bind(
    user.id,
    parameters.resolution,
    parameters.bounds.south,
    parameters.bounds.north,
    parameters.bounds.west,
    parameters.bounds.east,
    parameters.since,
    parameters.since,
    MAX_CELLS + 1,
  ).all();
  const records = cells.results ?? [];
  if (records.length > MAX_CELLS) {
    throw new HttpError(422, "Heatmap viewport is too dense; zoom in");
  }
  return response({
    scope: "mine",
    range: parameters.range,
    resolution: parameters.resolution,
    cells: records,
  });
}

export function createHeatmapHandler(options) {
  if (!options.db || typeof options.jwtSecret !== "string" || options.jwtSecret.length < 32) {
    return async () => response({ error: "Ride heatmap is unavailable" }, 503);
  }
  const dependencies = {
    ...options,
    logError: options.logError ?? ((message, details) => console.error(message, details)),
    now: options.now ?? Date.now,
  };
  return async function handleHeatmap(request) {
    try {
      if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
      return await getHeatmap(request, dependencies);
    } catch (error) {
      if (error instanceof HttpError) return response({ error: error.message }, error.status);
      dependencies.logError("Ride heatmap request failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return response({ error: "Ride heatmap request failed" }, 500);
    }
  };
}
