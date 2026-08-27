import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAuthHandler } from "../worker/auth.js";
import { createHeatmapHandler, geohash, geohashCenter, heatCellContributions, resolutionForZoom } from "../worker/heatmap.js";
import { createRideHandler } from "../worker/rides.js";

const JWT_SECRET = "test-jwt-secret-that-is-at-least-32-bytes";
const PASSWORD_PEPPER = "test-password-pepper-at-least-32-bytes";
const ORIGIN = "https://atlas.test";
const DAY_MS = 24 * 60 * 60 * 1_000;
const migrationsDirectory = fileURLToPath(new URL("../drizzle/", import.meta.url));

class Statement {
  constructor(db, sql, parameters = []) { this.db = db; this.sql = sql; this.parameters = parameters; }
  bind(...parameters) { return new Statement(this.db, this.sql, parameters); }
  first() { return Promise.resolve(this.db.database.prepare(this.sql).get(...this.parameters) ?? null); }
  all() { return Promise.resolve({ results: this.db.database.prepare(this.sql).all(...this.parameters) }); }
  runSync() { const result = this.db.database.prepare(this.sql).run(...this.parameters); return { success: true, meta: { changes: Number(result.changes) } }; }
  run() { return Promise.resolve(this.runSync()); }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(migrationsDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
      this.database.exec(readFileSync(join(migrationsDirectory, name), "utf8").replaceAll("--> statement-breakpoint", ""));
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try { const results = statements.map((statement) => statement.runSync()); this.database.exec("COMMIT"); return results; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close() { this.database.close(); }
}

function fixture(now = 1_800_000_000_000, options = {}) {
  const db = new TestD1();
  const dependencies = { db, jwtSecret: JWT_SECRET, passwordPepper: PASSWORD_PEPPER, now: () => now, randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)), ...options };
  return {
    db,
    auth: createAuthHandler(dependencies),
    rides: createRideHandler(dependencies),
    heatmap: createHeatmapHandler(dependencies),
  };
}

function request(path, { authorization, body, cookies = {}, method = "POST", origin = ORIGIN } = {}) {
  const headers = new Headers({ "cf-connecting-ip": "192.0.2.1" });
  if (origin !== null) headers.set("origin", origin);
  if (authorization !== undefined) headers.set("authorization", authorization);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (Object.keys(cookies).length) headers.set("cookie", Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function setCookies(response, jar) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    jar[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
  }
}

async function anonymous(instance) {
  const jar = {};
  const response = await instance.auth(request("/api/auth/anonymous", { cookies: jar }));
  assert.equal(response.status, 201);
  setCookies(response, jar);
  return jar;
}

async function nativeAnonymous(instance) {
  const response = await instance.auth(request("/api/mobile/v1/auth/anonymous", {
    body: {},
    origin: null,
  }));
  assert.equal(response.status, 201);
  return response.json();
}

function point(sequence, recordedAt, latitude = 30.2672, longitude = -97.7431) {
  return { sequence, recordedAt, latitude, longitude, accuracyMeters: 12, altitudeMeters: null, speedMetersPerSecond: null, headingDegrees: null, quality: "good" };
}

test("owner can create, retry, and complete an ordered ride batch", async () => {
  const instance = fixture();
  const jar = await anonymous(instance);
  const rideId = "ride_test_0000000000000001";
  const created = await instance.rides(request("/api/rides", { cookies: jar, body: { id: rideId, startedAt: 1_800_000_000_000 } }));
  assert.equal(created.status, 201);
  const batch = { id: "batch_test_000000000000001", points: [point(0, 1_800_000_000_000), point(1, 1_800_000_001_000, 30.2673, -97.7432)] };
  const received = await instance.rides(request(`/api/rides/${rideId}/batches`, { cookies: jar, body: batch }));
  assert.equal(received.status, 201);
  const firstBody = await received.json();
  assert.equal(firstBody.acceptedPointCount, 2);
  assert.ok(firstBody.distanceMeters > 0);
  const retried = await instance.rides(request(`/api/rides/${rideId}/batches`, { cookies: jar, body: batch }));
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).received, false);
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM ride_points WHERE ride_id = ?").get(rideId).count, 2);
  const completed = await instance.rides(request(`/api/rides/${rideId}/complete`, { cookies: jar }));
  assert.equal(completed.status, 200);
  const completedRide = (await completed.json()).ride;
  assert.equal(completedRide.status, "completed");
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    3,
  );
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cells").get().count,
    3,
  );
  const retriedCompletion = await instance.rides(request(`/api/rides/${rideId}/complete`, { cookies: jar }));
  assert.equal(retriedCompletion.status, 200);
  assert.deepEqual((await retriedCompletion.json()).ride, completedRide);
  instance.db.close();
});

test("private heatmap reads owner-scoped derived cells without returning route points", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const stranger = await anonymous(instance);
  const rideId = "ride_test_heatmap_000000001";
  await instance.rides(request("/api/rides", {
    cookies: owner,
    body: { id: rideId, startedAt: 1_800_000_000_000 },
  }));
  await instance.rides(request(`/api/rides/${rideId}/batches`, {
    cookies: owner,
    body: {
      id: "batch_test_heatmap_0000001",
      points: [
        point(0, 1_800_000_000_000),
        point(1, 1_800_000_001_000, 30.2673, -97.7432),
      ],
    },
  }));
  await instance.rides(request(`/api/rides/${rideId}/complete`, { cookies: owner }));

  const path = "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=90d";
  const unauthenticated = await instance.heatmap(request(path, { method: "GET" }));
  assert.equal(unauthenticated.status, 401);
  const response = await instance.heatmap(request(path, { method: "GET", cookies: owner }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["cells", "range", "resolution", "scope"]);
  assert.equal(body.scope, "mine");
  assert.equal(body.resolution, 7);
  assert.equal(body.cells.length, 1);
  assert.deepEqual(Object.keys(body.cells[0]).sort(), ["cellId", "distanceMeters", "latitude", "longitude", "rideCount"]);
  assert.equal(body.cells[0].rideCount, 1);
  assert.ok(body.cells[0].distanceMeters > 0);

  const foreign = await instance.heatmap(request(path, { method: "GET", cookies: stranger }));
  assert.equal(foreign.status, 200);
  assert.deepEqual((await foreign.json()).cells, []);
  instance.db.close();
});

test("private heatmap backfills completed rides that predate heatmap contributions", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const rideId = "ride_test_heatmap_backfill01";
  await instance.rides(request("/api/rides", {
    cookies: owner,
    body: { id: rideId, startedAt: 1_800_000_000_000 },
  }));
  await instance.rides(request(`/api/rides/${rideId}/batches`, {
    cookies: owner,
    body: {
      id: "batch_test_heatmap_backfill1",
      points: [point(0, 1_800_000_000_000), point(1, 1_800_000_001_000, 30.2673, -97.7432)],
    },
  }));
  instance.db.database.prepare(
    "UPDATE rides SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?",
  ).run(1_800_000_002_000, 1_800_000_002_000, rideId);

  const preparing = await instance.heatmap(request(
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=90d",
    { method: "GET", cookies: owner },
  ));
  assert.equal(preparing.status, 202);
  const response = await instance.heatmap(request(
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=90d",
    { method: "GET", cookies: owner },
  ));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cells.length, 1);
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    3,
  );
  assert.equal(
    instance.db.database.prepare("SELECT heatmap_backfilled_at AS heatmapBackfilledAt FROM rides WHERE id = ?").get(rideId).heatmapBackfilledAt,
    1_800_000_002_000,
  );
  instance.db.close();
});

test("private heatmap retries incomplete contribution backfills before marking a ride complete", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const userId = instance.db.database.prepare("SELECT id FROM users").get().id;
  const rideId = "ride_test_heatmap_retry0001";
  const completedAt = 1_800_000_002_000;
  const points = [point(0, 1_800_000_000_000), point(1, 1_800_000_001_000, 30.2673, -97.7432)];
  await instance.rides(request("/api/rides", {
    cookies: owner,
    body: { id: rideId, startedAt: points[0].recordedAt },
  }));
  await instance.rides(request(`/api/rides/${rideId}/batches`, {
    cookies: owner,
    body: { id: "batch_test_heatmap_retry01", points },
  }));
  instance.db.database.prepare(
    "UPDATE rides SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?",
  ).run(completedAt, completedAt, rideId);
  const contribution = heatCellContributions(points, completedAt)[0];
  instance.db.database.prepare(
    `INSERT INTO ride_heat_cell_contributions
      (ride_id, user_id, resolution, cell_id, bucket_start, latitude, longitude, distance_meters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(rideId, userId, contribution.resolution, contribution.cellId, contribution.bucketStart, contribution.latitude, contribution.longitude, contribution.distanceMeters);

  const preparing = await instance.heatmap(request(
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=90d",
    { method: "GET", cookies: owner },
  ));
  assert.equal(preparing.status, 202);
  const response = await instance.heatmap(request(
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=90d",
    { method: "GET", cookies: owner },
  ));
  assert.equal(response.status, 200);
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    3,
  );
  assert.equal(
    instance.db.database.prepare("SELECT heatmap_backfilled_at AS heatmapBackfilledAt FROM rides WHERE id = ?").get(rideId).heatmapBackfilledAt,
    completedAt,
  );
  instance.db.close();
});

test("private heatmap advances a large historical backfill without replaying written contributions", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const userId = instance.db.database.prepare("SELECT id FROM users").get().id;
  const rideId = "ride_test_heatmap_large0001";
  const batchId = "batch_test_heatmap_large01";
  const completedAt = 1_800_000_002_000;
  const points = Array.from({ length: 20 }, (_, sequence) => point(
    sequence,
    1_800_000_000_000 + sequence * 1_000,
    30.2672,
    -99 + sequence / 10,
  ));
  const contributions = heatCellContributions(points, completedAt);
  assert.ok(contributions.length > 50);
  instance.db.database.prepare(
    `INSERT INTO rides
      (id, user_id, status, started_at, ended_at, distance_meters, accepted_point_count)
     VALUES (?, ?, 'completed', ?, ?, 0, ?)`,
  ).run(rideId, userId, points[0].recordedAt, completedAt, points.length);
  instance.db.database.prepare(
    `INSERT INTO ride_upload_batches (id, ride_id, first_sequence, point_count)
     VALUES (?, ?, 0, ?)`,
  ).run(batchId, rideId, points.length);
  const insertPoint = instance.db.database.prepare(
    `INSERT INTO ride_points
      (id, ride_id, upload_batch_id, sequence, recorded_at, latitude, longitude, accuracy_meters, quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ridePoint of points) {
    insertPoint.run(
      `${rideId}_${ridePoint.sequence}`,
      rideId,
      batchId,
      ridePoint.sequence,
      ridePoint.recordedAt,
      ridePoint.latitude,
      ridePoint.longitude,
      ridePoint.accuracyMeters,
      ridePoint.quality,
    );
  }
  const path = "/api/heatmap?scope=mine&bounds=-100,29,-96,31&zoom=15&range=90d";

  assert.equal((await instance.heatmap(request(path, { method: "GET", cookies: owner }))).status, 202);
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    50,
  );
  assert.equal(
    instance.db.database.prepare("SELECT heatmap_backfilled_at AS heatmapBackfilledAt FROM rides WHERE id = ?").get(rideId).heatmapBackfilledAt,
    null,
  );

  assert.equal((await instance.heatmap(request(path, { method: "GET", cookies: owner }))).status, 202);
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    contributions.length,
  );
  assert.equal(
    instance.db.database.prepare("SELECT heatmap_backfilled_at AS heatmapBackfilledAt FROM rides WHERE id = ?").get(rideId).heatmapBackfilledAt,
    completedAt,
  );
  assert.equal((await instance.heatmap(request(path, { method: "GET", cookies: owner }))).status, 200);
  instance.db.close();
});

test("ride completion advances a large contribution set without an unbounded D1 batch", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const userId = instance.db.database.prepare("SELECT id FROM users").get().id;
  const rideId = "ride_test_completion_large0001";
  const batchId = "batch_test_completion_large01";
  const points = Array.from({ length: 20 }, (_, sequence) => point(
    sequence,
    1_800_000_000_000 + sequence * 1_000,
    30.2672,
    -99 + sequence / 10,
  ));
  const contributions = heatCellContributions(points, 1_800_000_000_000);
  assert.ok(contributions.length > 50);
  instance.db.database.prepare(
    `INSERT INTO rides
      (id, user_id, status, started_at, distance_meters, accepted_point_count)
     VALUES (?, ?, 'recording', ?, 0, ?)`,
  ).run(rideId, userId, points[0].recordedAt, points.length);
  instance.db.database.prepare(
    `INSERT INTO ride_upload_batches (id, ride_id, first_sequence, point_count)
     VALUES (?, ?, 0, ?)`,
  ).run(batchId, rideId, points.length);
  const insertPoint = instance.db.database.prepare(
    `INSERT INTO ride_points
      (id, ride_id, upload_batch_id, sequence, recorded_at, latitude, longitude, accuracy_meters, quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ridePoint of points) {
    insertPoint.run(
      `${rideId}_${ridePoint.sequence}`,
      rideId,
      batchId,
      ridePoint.sequence,
      ridePoint.recordedAt,
      ridePoint.latitude,
      ridePoint.longitude,
      ridePoint.accuracyMeters,
      ridePoint.quality,
    );
  }

  const first = await instance.rides(request(`/api/rides/${rideId}/complete`, { cookies: owner }));
  assert.equal(first.status, 202);
  assert.equal(first.headers.get("retry-after"), "1");
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    50,
  );
  assert.equal(
    instance.db.database.prepare("SELECT completion_started_at AS completionStartedAt FROM rides WHERE id = ?").get(rideId).completionStartedAt,
    1_800_000_000_000,
  );

  let completed;
  for (let attempts = 0; attempts < Math.ceil(contributions.length / 50); attempts += 1) {
    completed = await instance.rides(request(`/api/rides/${rideId}/complete`, { cookies: owner }));
    if (completed.status !== 202) break;
  }
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).ride.status, "completed");
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cell_contributions WHERE ride_id = ?").get(rideId).count,
    contributions.length,
  );
  instance.db.close();
});

test("private heatmap combines daily rows with the same cell ID", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const userId = instance.db.database.prepare("SELECT id FROM users").get().id;
  const cellId = geohash(30.2672, -97.7431, 7);
  const insert = instance.db.database.prepare(
    `INSERT INTO ride_heat_cells
      (user_id, resolution, cell_id, bucket_start, latitude, longitude, ride_count, distance_meters)
     VALUES (?, 7, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(userId, cellId, 1_799_900_800_000, 30.2672, -97.7431, 1, 10);
  insert.run(userId, cellId, 1_799_987_200_000, 30.2673, -97.7432, 2, 20);

  const response = await instance.heatmap(request(
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=90d",
    { method: "GET", cookies: owner },
  ));
  assert.equal(response.status, 200);
  const cells = (await response.json()).cells;
  assert.deepEqual(cells, [{
    cellId,
    ...geohashCenter(cellId),
    rideCount: 3,
    distanceMeters: 30,
  }]);
  instance.db.close();
});

test("private heatmap includes the full oldest daily bucket in a range", async () => {
  const now = 2_000 * DAY_MS + 12 * 60 * 60 * 1_000;
  const instance = fixture(now);
  const owner = await anonymous(instance);
  const userId = instance.db.database.prepare("SELECT id FROM users").get().id;
  const cellId = geohash(30.2672, -97.7431, 7);
  instance.db.database.prepare(
    `INSERT INTO ride_heat_cells
      (user_id, resolution, cell_id, bucket_start, latitude, longitude, ride_count, distance_meters)
     VALUES (?, 7, ?, ?, ?, ?, 1, 10)`,
  ).run(userId, cellId, 1_970 * DAY_MS, 30.2672, -97.7431);

  const response = await instance.heatmap(request(
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=30d",
    { method: "GET", cookies: owner },
  ));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cells.length, 1);
  instance.db.close();
});

test("private heatmap requires a bounded viewport, a supported range, and scope=mine", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  for (const path of [
    "/api/heatmap?scope=community&bounds=-97.75,30.26,-97.73,30.28&zoom=15",
    "/api/heatmap?scope=mine&bounds=-120,20,-90,50&zoom=15",
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15&range=7d",
    "/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=23",
  ]) {
    const response = await instance.heatmap(request(path, { method: "GET", cookies: owner }));
    assert.equal(response.status, 400, path);
  }
  const method = await instance.heatmap(request("/api/heatmap?scope=mine&bounds=-97.75,30.26,-97.73,30.28&zoom=15", {
    method: "POST",
    cookies: owner,
    body: {},
  }));
  assert.equal(method.status, 405);
  instance.db.close();
});

test("heatmap segment aggregation uses distance and only one contribution per ride cell", () => {
  const points = [
    { latitude: 30.2672, longitude: -97.7431 },
    { latitude: 30.2673, longitude: -97.7432 },
    { latitude: 30.2674, longitude: -97.7433 },
  ];
  const contributions = heatCellContributions(points, 1_800_000_000_000);
  assert.equal(resolutionForZoom(12), 5);
  assert.equal(resolutionForZoom(13), 6);
  assert.equal(resolutionForZoom(15), 7);
  assert.equal(geohash(30.26725, -97.74315, 7), geohash(30.26725, -97.74315, 7));
  assert.ok(contributions.length >= 3 && contributions.length <= 6);
  for (const contribution of contributions) assert.ok(contribution.distanceMeters > 0);
});

test("ride ingestion accepts the shared GPS policy minimum movement allowance", async () => {
  const instance = fixture();
  const jar = await anonymous(instance);
  const rideId = "ride_test_0000000000000010";
  const created = await instance.rides(request("/api/rides", { cookies: jar, body: { id: rideId, startedAt: 1_800_000_000_000 } }));
  assert.equal(created.status, 201);

  const received = await instance.rides(request(`/api/rides/${rideId}/batches`, {
    cookies: jar,
    body: {
      id: "batch_test_000000000000011",
      points: [point(0, 1_800_000_000_000), point(1, 1_800_000_001_000, 30.26783, -97.7431)],
    },
  }));
  assert.equal(received.status, 201);
  instance.db.close();
});

test("existing ride creation can be retried after its original creation window", async () => {
  let now = 1_800_000_000_000;
  const instance = fixture(now, { now: () => now });
  const jar = await anonymous(instance);
  const rideId = "ride_test_0000000000000011";
  const body = { id: rideId, startedAt: now };
  const created = await instance.rides(request("/api/rides", { cookies: jar, body }));
  assert.equal(created.status, 201);

  now += 24 * 60 * 60 * 1_000 + 1;
  const refreshedSession = await instance.auth(request("/api/auth/refresh", { cookies: jar }));
  assert.equal(refreshedSession.status, 200);
  setCookies(refreshedSession, jar);
  const retried = await instance.rides(request("/api/rides", { cookies: jar, body }));
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).created, false);
  const conflicting = await instance.rides(request("/api/rides", {
    cookies: jar,
    body: { id: rideId, startedAt: body.startedAt + 1 },
  }));
  assert.equal(conflicting.status, 409);
  instance.db.close();
});

test("bearer access can mutate its own rides without an Origin header", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const authorization = `Bearer ${owner.atlas_access}`;
  const rideId = "ride_test_0000000000000007";
  const created = await instance.rides(request("/api/rides", {
    authorization,
    body: { id: rideId, startedAt: 1_800_000_000_000 },
    origin: null,
  }));
  assert.equal(created.status, 201);
  const batch = await instance.rides(request(`/api/rides/${rideId}/batches`, {
    authorization,
    body: { id: "batch_test_000000000000007", points: [point(0, 1_800_000_000_000)] },
    origin: null,
  }));
  assert.equal(batch.status, 201);
  const completed = await instance.rides(request(`/api/rides/${rideId}/complete`, { authorization, origin: null }));
  assert.equal(completed.status, 200);
  const deleted = await instance.rides(request(`/api/rides/${rideId}`, { authorization, method: "DELETE", origin: null }));
  assert.equal(deleted.status, 204);
  instance.db.close();
});

test("native ride mutations are rate limited by authenticated owner before batch writes", async () => {
  const keys = [];
  const instance = fixture(1_800_000_000_000, {
    rateLimiter: {
      async limit({ key }) {
        keys.push(key);
        return { success: keys.length === 1 };
      },
    },
  });
  const owner = await anonymous(instance);
  const user = instance.db.database.prepare("SELECT id FROM users").get();
  const authorization = `Bearer ${owner.atlas_access}`;
  const rideId = "ride_test_0000000000000010";
  const created = await instance.rides(request("/api/rides", {
    authorization,
    body: { id: rideId, startedAt: 1_800_000_000_000 },
    origin: null,
  }));
  assert.equal(created.status, 201);
  const limited = await instance.rides(request(`/api/rides/${rideId}/batches`, {
    authorization,
    body: { id: "batch_test_000000000000010", points: [point(0, 1_800_000_000_000)] },
    origin: null,
  }));
  assert.equal(limited.status, 429);
  assert.deepEqual(keys, [`native-ride:${user.id}`, `native-ride:${user.id}`]);
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM ride_points WHERE ride_id = ?").get(rideId).count, 0);
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cells").get().count, 0);
  instance.db.close();
});

test("bearer access remains owner-scoped and cannot be replaced by a malformed header", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const stranger = await anonymous(instance);
  const rideId = "ride_test_0000000000000008";
  await instance.rides(request("/api/rides", { cookies: owner, body: { id: rideId, startedAt: 1_800_000_000_000 } }));

  const foreignDelete = await instance.rides(request(`/api/rides/${rideId}`, {
    authorization: `Bearer ${stranger.atlas_access}`,
    method: "DELETE",
    origin: null,
  }));
  assert.equal(foreignDelete.status, 404);
  const malformedHeader = await instance.rides(request(`/api/rides/${rideId}`, {
    authorization: "Bearer not-a-valid-access-token",
    cookies: owner,
    method: "DELETE",
    origin: null,
  }));
  assert.equal(malformedHeader.status, 401);
  const stillPresent = instance.db.database.prepare("SELECT count(*) AS count FROM rides WHERE id = ?").get(rideId);
  assert.equal(stillPresent.count, 1);
  instance.db.close();
});

test("a native refresh token cannot authenticate a ride request", async () => {
  const instance = fixture();
  const session = await nativeAnonymous(instance);
  const rideId = "ride_test_refresh_denied_01";
  const denied = await instance.rides(request("/api/rides", {
    authorization: `Bearer ${session.refreshToken}`,
    body: { id: rideId, startedAt: 1_800_000_000_000 },
    origin: null,
  }));

  assert.equal(denied.status, 401);
  assert.equal(
    instance.db.database.prepare("SELECT count(*) AS count FROM rides WHERE id = ?").get(rideId).count,
    0,
  );
  instance.db.close();
});

test("unexpected ride failures log only an error class", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const logs = [];
  const secret = "provider-secret-raw-geometry-30.2672--97.7431";
  const rides = createRideHandler({
    db: {
      prepare() {
        throw new Error(secret);
      },
    },
    jwtSecret: JWT_SECRET,
    logError: (...entry) => logs.push(entry),
    now: () => 1_800_000_000_000,
  });
  const response = await rides(request("/api/rides", {
    authorization: `Bearer ${owner.atlas_access}`,
    body: {
      id: "ride_test_log_redaction_01",
      startedAt: 1_800_000_000_000,
      geometry: [[-97.7431, 30.2672]],
    },
    origin: null,
  }));

  assert.equal(response.status, 500);
  assert.deepEqual(logs, [["Ride history request failed", { error: "Error" }]]);
  assert.equal(JSON.stringify(logs).includes(owner.atlas_access), false);
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.doesNotMatch(JSON.stringify(logs), /30\.2672|-97\.7431/);
  instance.db.close();
});

test("cookie-authenticated ride mutations still require a same-origin request", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const response = await instance.rides(request("/api/rides", {
    body: { id: "ride_test_0000000000000009", startedAt: 1_800_000_000_000 },
    cookies: owner,
    origin: null,
  }));
  assert.equal(response.status, 403);
  instance.db.close();
});

test("ride ingestion rejects foreign, out-of-order, and unacceptable GPS data", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const stranger = await anonymous(instance);
  const rideId = "ride_test_0000000000000002";
  await instance.rides(request("/api/rides", { cookies: owner, body: { id: rideId, startedAt: 1_800_000_000_000 } }));
  const foreign = await instance.rides(request(`/api/rides/${rideId}/batches`, { cookies: stranger, body: { id: "batch_test_000000000000002", points: [point(0, 1_800_000_000_000)] } }));
  assert.equal(foreign.status, 404);
  const invalid = await instance.rides(request(`/api/rides/${rideId}/batches`, { cookies: owner, body: { id: "batch_test_000000000000003", points: [{ ...point(1, 1_800_000_000_000), accuracyMeters: 500, quality: "poor" }] } }));
  assert.equal(invalid.status, 400);
  const skipped = await instance.rides(request(`/api/rides/${rideId}/batches`, { cookies: owner, body: { id: "batch_test_000000000000004", points: [point(1, 1_800_000_000_000)] } }));
  assert.equal(skipped.status, 409);
  instance.db.close();
});

test("private history reads and deletes only the authenticated owner's rides", async () => {
  const instance = fixture();
  const unauthenticated = await instance.rides(request("/api/rides", { method: "GET" }));
  assert.equal(unauthenticated.status, 401);
  const owner = await anonymous(instance);
  const stranger = await anonymous(instance);
  const rideId = "ride_test_0000000000000003";
  await instance.rides(request("/api/rides", { cookies: owner, body: { id: rideId, startedAt: 1_800_000_000_000 } }));
  await instance.rides(request(`/api/rides/${rideId}/batches`, { cookies: owner, body: { id: "batch_test_000000000000005", points: [point(0, 1_800_000_000_000), point(1, 1_800_000_001_000, 30.2673, -97.7432)] } }));
  await instance.rides(request(`/api/rides/${rideId}/complete`, { cookies: owner }));

  const list = await instance.rides(request("/api/rides?limit=25", { method: "GET", cookies: owner }));
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual((await list.json()).rides.map((ride) => ride.id), [rideId]);
  const detail = await instance.rides(request(`/api/rides/${rideId}`, { method: "GET", cookies: owner }));
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).points.length, 2);

  const foreignRead = await instance.rides(request(`/api/rides/${rideId}`, { method: "GET", cookies: stranger }));
  const foreignDelete = await instance.rides(request(`/api/rides/${rideId}`, { method: "DELETE", cookies: stranger }));
  assert.equal(foreignRead.status, 404);
  assert.equal(foreignDelete.status, 404);
  const deleted = await instance.rides(request(`/api/rides/${rideId}`, { method: "DELETE", cookies: owner }));
  assert.equal(deleted.status, 204);
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM ride_points WHERE ride_id = ?").get(rideId).count, 0);
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM ride_heat_cells").get().count, 0);
  const missing = await instance.rides(request(`/api/rides/${rideId}`, { method: "GET", cookies: owner }));
  assert.equal(missing.status, 404);
  instance.db.close();
});

test("private history cursor reaches older rides in newest-first order", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const older = "ride_test_0000000000000005";
  const newer = "ride_test_0000000000000006";
  for (const [id, startedAt] of [[older, 1_799_999_998_000], [newer, 1_799_999_999_000]]) {
    await instance.rides(request("/api/rides", { cookies: owner, body: { id, startedAt } }));
    await instance.rides(request(`/api/rides/${id}/complete`, { cookies: owner }));
  }
  const first = await instance.rides(request("/api/rides?limit=1", { method: "GET", cookies: owner }));
  const firstBody = await first.json();
  assert.deepEqual(firstBody.rides.map((ride) => ride.id), [newer]);
  assert.equal(typeof firstBody.nextCursor, "string");
  const second = await instance.rides(request(`/api/rides?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, { method: "GET", cookies: owner }));
  const secondBody = await second.json();
  assert.deepEqual(secondBody.rides.map((ride) => ride.id), [older]);
  assert.equal(secondBody.nextCursor, null);
  instance.db.close();
});

test("account deletion clears sessions and cascades through private rides", async () => {
  const instance = fixture();
  const owner = await anonymous(instance);
  const rideId = "ride_test_0000000000000004";
  await instance.rides(request("/api/rides", { cookies: owner, body: { id: rideId, startedAt: 1_800_000_000_000 } }));
  const accessToken = owner.atlas_access;
  const deleted = await instance.auth(request("/api/auth/account", { method: "DELETE", cookies: owner }));
  assert.equal(deleted.status, 204);
  assert.equal(deleted.headers.get("cache-control"), "no-store");
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM users").get().count, 0);
  assert.equal(instance.db.database.prepare("SELECT count(*) AS count FROM rides").get().count, 0);
  const revoked = await instance.auth(request("/api/auth/me", { method: "GET", cookies: { atlas_access: accessToken } }));
  assert.equal(revoked.status, 401);
  instance.db.close();
});
