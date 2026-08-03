import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAuthHandler } from "../worker/auth.js";
import { createRideHandler } from "../worker/rides.js";

const JWT_SECRET = "test-jwt-secret-that-is-at-least-32-bytes";
const PASSWORD_PEPPER = "test-password-pepper-at-least-32-bytes";
const ORIGIN = "https://atlas.test";
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

function fixture(now = 1_800_000_000_000) {
  const db = new TestD1();
  const dependencies = { db, jwtSecret: JWT_SECRET, passwordPepper: PASSWORD_PEPPER, now: () => now, randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)) };
  return { db, auth: createAuthHandler(dependencies), rides: createRideHandler(dependencies) };
}

function request(path, { body, cookies = {}, method = "POST" } = {}) {
  const headers = new Headers({ origin: ORIGIN, "cf-connecting-ip": "192.0.2.1" });
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
  assert.equal((await completed.json()).ride.status, "completed");
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
  const missing = await instance.rides(request(`/api/rides/${rideId}`, { method: "GET", cookies: owner }));
  assert.equal(missing.status, 404);
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
