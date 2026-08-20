import { authenticateRequest, HttpError, requiresSameOrigin } from "./auth.js";

const MAX_BATCH_POINTS = 100;
const MAX_CREATE_BYTES = 4 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_POINT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_CYCLING_SPEED_MPS = 35;

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

function emptyResponse(status = 204) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function assertSameOrigin(request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new HttpError(403, "Invalid request origin");
  }
}

async function authenticateMutation(request, dependencies) {
  const user = await authenticateRequest(request, dependencies);
  if (requiresSameOrigin(request)) {
    assertSameOrigin(request);
    return user;
  }
  if (dependencies.rateLimiter) {
    const result = await dependencies.rateLimiter.limit({
      key: `native-ride:${user.id}`,
    });
    if (!result.success) throw new HttpError(429, "Too many native ride requests. Try again shortly.");
  }
  return user;
}

async function readJson(request, maximumBytes) {
  try {
    const declaredSize = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
      throw new HttpError(413, "Request body is too large");
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBytes) {
      throw new HttpError(413, "Request body is too large");
    }
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON body");
  }
}

function isId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function qualityForAccuracy(accuracy) {
  if (accuracy <= 25) return "good";
  if (accuracy <= 75) return "fair";
  if (accuracy <= 100) return "poor";
  return null;
}

function validatePoint(value, previous, startedAt, now) {
  if (!value || typeof value !== "object" || !Number.isInteger(value.sequence)) {
    throw new HttpError(400, "Each point needs an integer sequence");
  }
  if (!Number.isInteger(value.recordedAt) || value.recordedAt < startedAt - 60_000 || value.recordedAt > now + MAX_FUTURE_MS || value.recordedAt < now - MAX_POINT_AGE_MS) {
    throw new HttpError(400, "Point timestamp is outside the allowed recording window");
  }
  if (!finite(value.latitude) || value.latitude < -90 || value.latitude > 90 || !finite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    throw new HttpError(400, "Point coordinates are invalid");
  }
  if (!finite(value.accuracyMeters) || value.accuracyMeters < 0 || value.accuracyMeters > 100 || qualityForAccuracy(value.accuracyMeters) !== value.quality) {
    throw new HttpError(400, "Point GPS quality is not accepted");
  }
  for (const key of ["altitudeMeters", "speedMetersPerSecond", "headingDegrees"]) {
    if (value[key] !== null && value[key] !== undefined && !finite(value[key])) throw new HttpError(400, `Point ${key} is invalid`);
  }
  if (value.speedMetersPerSecond !== null && value.speedMetersPerSecond !== undefined && value.speedMetersPerSecond < 0) throw new HttpError(400, "Point speed is invalid");
  if (value.headingDegrees !== null && value.headingDegrees !== undefined && (value.headingDegrees < 0 || value.headingDegrees >= 360)) throw new HttpError(400, "Point heading is invalid");
  if (previous && (value.sequence !== previous.sequence + 1 || value.recordedAt < previous.recordedAt)) throw new HttpError(409, "Points must be ordered");
}

function distanceMeters(left, right) {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validatePlausibleMovement(previous, point) {
  if (!previous) return;
  const elapsedSeconds = (point.recordedAt - previous.recordedAt) / 1000;
  const distance = distanceMeters(previous, point);
  if (elapsedSeconds === 0 ? distance > Math.max(previous.accuracyMeters, point.accuracyMeters) : distance / elapsedSeconds > MAX_CYCLING_SPEED_MPS) {
    throw new HttpError(400, "Point movement is implausible");
  }
}

function pointValues(point, rideId, batchId) {
  return [crypto.randomUUID(), rideId, batchId, point.sequence, point.recordedAt, point.latitude, point.longitude, point.accuracyMeters, point.altitudeMeters ?? null, point.speedMetersPerSecond ?? null, point.headingDegrees ?? null, point.quality];
}

async function createRide(request, dependencies) {
  const user = await authenticateMutation(request, dependencies);
  const body = await readJson(request, MAX_CREATE_BYTES);
  if (!isId(body.id) || !Number.isInteger(body.startedAt) || body.startedAt > dependencies.now() + MAX_FUTURE_MS || body.startedAt < dependencies.now() - MAX_POINT_AGE_MS) {
    throw new HttpError(400, "Invalid ride start");
  }
  const existing = await dependencies.db.prepare(
    "SELECT id, status, started_at AS startedAt FROM rides WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  ).bind(body.id, user.id).first();
  if (existing) return response({ ride: existing, created: false });
  try {
    await dependencies.db.prepare(
      `INSERT INTO rides (id, user_id, status, started_at, distance_meters, accepted_point_count, created_at, updated_at)
       VALUES (?, ?, 'recording', ?, 0, 0, ?, ?)`,
    ).bind(body.id, user.id, body.startedAt, dependencies.now(), dependencies.now()).run();
  } catch (error) {
    if (/unique constraint/iu.test(String(error))) throw new HttpError(409, "Ride already exists");
    throw error;
  }
  return response({ ride: { id: body.id, status: "recording", startedAt: body.startedAt }, created: true }, 201);
}

async function uploadBatch(request, dependencies, rideId) {
  const user = await authenticateMutation(request, dependencies);
  const body = await readJson(request, MAX_BATCH_BYTES);
  if (!isId(body.id) || !Array.isArray(body.points) || body.points.length < 1 || body.points.length > MAX_BATCH_POINTS) throw new HttpError(400, "Invalid ride batch");
  const ride = await dependencies.db.prepare(
    "SELECT id, started_at AS startedAt, accepted_point_count AS acceptedPointCount, distance_meters AS distanceMeters FROM rides WHERE id = ? AND user_id = ? AND status = 'recording' AND deleted_at IS NULL",
  ).bind(rideId, user.id).first();
  if (!ride) throw new HttpError(404, "Ride not found");
  const existing = await dependencies.db.prepare(
    "SELECT first_sequence AS firstSequence, point_count AS pointCount FROM ride_upload_batches WHERE id = ? AND ride_id = ?",
  ).bind(body.id, rideId).first();
  if (existing) {
    if (existing.firstSequence !== body.points[0]?.sequence || existing.pointCount !== body.points.length) throw new HttpError(409, "Batch ID was already used");
    return response({ acceptedPointCount: ride.acceptedPointCount, distanceMeters: ride.distanceMeters, received: false });
  }
  const last = await dependencies.db.prepare(
    "SELECT sequence, recorded_at AS recordedAt, latitude, longitude, accuracy_meters AS accuracyMeters FROM ride_points WHERE ride_id = ? ORDER BY sequence DESC LIMIT 1",
  ).bind(rideId).first();
  let previous = last ?? null;
  for (const point of body.points) {
    validatePoint(point, previous, ride.startedAt, dependencies.now());
    validatePlausibleMovement(previous, point);
    previous = point;
  }
  if (body.points[0].sequence !== ride.acceptedPointCount) throw new HttpError(409, "Batch is out of order");
  let addedDistance = 0;
  previous = last ?? null;
  for (const point of body.points) {
    if (previous) addedDistance += distanceMeters(previous, point);
    previous = point;
  }
  const now = dependencies.now();
  const statements = [
    dependencies.db.prepare(
      "INSERT INTO ride_upload_batches (id, ride_id, first_sequence, point_count, received_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(body.id, rideId, body.points[0].sequence, body.points.length, now),
    ...body.points.map((point) => dependencies.db.prepare(
      `INSERT INTO ride_points (id, ride_id, upload_batch_id, sequence, recorded_at, latitude, longitude, accuracy_meters, altitude_meters, speed_meters_per_second, heading_degrees, quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...pointValues(point, rideId, body.id))),
    dependencies.db.prepare(
      `UPDATE rides SET accepted_point_count = accepted_point_count + ?, distance_meters = distance_meters + ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'recording'`,
    ).bind(body.points.length, addedDistance, now, rideId, user.id),
  ];
  try {
    const results = await dependencies.db.batch(statements);
    if (results.at(-1)?.meta?.changes !== 1) throw new HttpError(404, "Ride not found");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (/unique constraint/iu.test(String(error))) throw new HttpError(409, "Batch conflicts with existing ride points");
    throw error;
  }
  return response({ acceptedPointCount: ride.acceptedPointCount + body.points.length, distanceMeters: ride.distanceMeters + addedDistance, received: true }, 201);
}

async function completeRide(request, dependencies, rideId) {
  const user = await authenticateMutation(request, dependencies);
  const ride = await dependencies.db.prepare(
    "SELECT id, accepted_point_count AS acceptedPointCount, distance_meters AS distanceMeters FROM rides WHERE id = ? AND user_id = ? AND status = 'recording' AND deleted_at IS NULL",
  ).bind(rideId, user.id).first();
  if (!ride) throw new HttpError(404, "Ride not found");
  const now = dependencies.now();
  const changed = await dependencies.db.prepare(
    "UPDATE rides SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'recording'",
  ).bind(now, now, rideId, user.id).run();
  if (changed.meta?.changes !== 1) throw new HttpError(409, "Ride could not be completed");
  return response({ ride: { ...ride, status: "completed", endedAt: now } });
}

function listLimit(request) {
  const value = new URL(request.url).searchParams.get("limit");
  if (value === null) return 50;
  if (!/^\d+$/u.test(value)) throw new HttpError(400, "Invalid history limit");
  return Math.min(Math.max(Number(value), 1), 100);
}

function encodeCursor(ride) {
  return btoa(JSON.stringify({ id: ride.id, startedAt: ride.startedAt }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(request) {
  const value = new URL(request.url).searchParams.get("cursor");
  if (value === null) return null;
  if (value.length > 256) throw new HttpError(400, "Invalid history cursor");
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const cursor = JSON.parse(atob(padded));
    if (!Number.isInteger(cursor.startedAt) || !isId(cursor.id)) throw new Error("Invalid cursor");
    return cursor;
  } catch {
    throw new HttpError(400, "Invalid history cursor");
  }
}

async function listRides(request, dependencies) {
  const user = await authenticateRequest(request, dependencies);
  const limit = listLimit(request);
  const cursor = decodeCursor(request);
  const rides = await dependencies.db.prepare(
    `SELECT id, status, title, started_at AS startedAt, ended_at AS endedAt,
            distance_meters AS distanceMeters, accepted_point_count AS acceptedPointCount
     FROM rides
     WHERE user_id = ? AND deleted_at IS NULL
       AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?))
     ORDER BY started_at DESC, id DESC
     LIMIT ?`,
  ).bind(
    user.id,
    cursor?.startedAt ?? null,
    cursor?.startedAt ?? null,
    cursor?.startedAt ?? null,
    cursor?.id ?? null,
    limit + 1,
  ).all();
  const records = rides.results ?? [];
  const page = records.slice(0, limit);
  return response({
    rides: page,
    nextCursor: records.length > limit ? encodeCursor(page.at(-1)) : null,
  });
}

async function getRide(request, dependencies, rideId) {
  const user = await authenticateRequest(request, dependencies);
  const ride = await dependencies.db.prepare(
    `SELECT id, status, title, started_at AS startedAt, ended_at AS endedAt,
            distance_meters AS distanceMeters, accepted_point_count AS acceptedPointCount
     FROM rides WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).bind(rideId, user.id).first();
  if (!ride) throw new HttpError(404, "Ride not found");
  const points = await dependencies.db.prepare(
    `SELECT sequence, recorded_at AS recordedAt, latitude, longitude, accuracy_meters AS accuracyMeters,
            altitude_meters AS altitudeMeters, speed_meters_per_second AS speedMetersPerSecond,
            heading_degrees AS headingDegrees, quality
     FROM ride_points WHERE ride_id = ? ORDER BY sequence ASC`,
  ).bind(rideId).all();
  return response({ ride, points: points.results ?? [] });
}

async function deleteRide(request, dependencies, rideId) {
  const user = await authenticateMutation(request, dependencies);
  const deleted = await dependencies.db.prepare(
    "DELETE FROM rides WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  ).bind(rideId, user.id).run();
  if (deleted.meta?.changes !== 1) throw new HttpError(404, "Ride not found");
  return emptyResponse();
}

export function createRideHandler(options) {
  if (!options.db || typeof options.jwtSecret !== "string" || options.jwtSecret.length < 32) {
    return async () => response({ error: "Ride history is unavailable" }, 503);
  }
  const dependencies = { ...options, now: options.now ?? Date.now };
  return async function handleRide(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/rides") {
        if (request.method === "POST") return await createRide(request, dependencies);
        if (request.method === "GET") return await listRides(request, dependencies);
      }
      const ride = path.match(/^\/api\/rides\/([A-Za-z0-9_-]{16,128})$/u);
      if (ride) {
        if (request.method === "GET") return await getRide(request, dependencies, ride[1]);
        if (request.method === "DELETE") return await deleteRide(request, dependencies, ride[1]);
      }
      const match = path.match(/^\/api\/rides\/([A-Za-z0-9_-]{16,128})\/(batches|complete)$/u);
      if (!match || request.method !== "POST") throw new HttpError(404, "Not found");
      return match[2] === "batches" ? await uploadBatch(request, dependencies, match[1]) : await completeRide(request, dependencies, match[1]);
    } catch (error) {
      if (error instanceof HttpError) return response({ error: error.message }, error.status);
      console.error("Ride history request failed", { error: error instanceof Error ? error.name : "UnknownError" });
      return response({ error: "Ride history request failed" }, 500);
    }
  };
}
